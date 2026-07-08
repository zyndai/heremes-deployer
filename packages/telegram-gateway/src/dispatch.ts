import type { ChatLink, TelegramUpdate, TelegramMessage, AgentEndpoint } from "./types";
import { parseCommand } from "./links";

export interface DispatchDeps {
  botUsername: string;
  links: {
    get(chatId: number): ChatLink | undefined;
    put(link: ChatLink): void;
    delete(chatId: number): boolean;
  };
  consumeToken(token: string): string | null;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendTyping?(chatId: number): Promise<void>;
  resolveAgent(tenantId: string): Promise<AgentEndpoint | null>;
  askAgent(agent: AgentEndpoint, sessionKey: string, text: string): Promise<string>;
  now?: () => number;
}

export interface IncomingMessage {
  chatId: number;
  text: string;
  who?: string;
}

export function extractMessage(update: TelegramUpdate): IncomingMessage | null {
  const m: TelegramMessage | undefined = update.message;
  if (!m || typeof m.text !== "string") return null;
  const who = m.from?.username ?? m.from?.first_name;
  return { chatId: m.chat.id, text: m.text, ...(who ? { who } : {}) };
}

const HELP_TEXT = [
  "🦅 Hermes Zynd",
  "",
  "I connect this chat to your own private Hermes agent.",
  "",
  "• Open the Connect link from your Zynd dashboard, then tap Start — that links this chat to your agent.",
  "• After that, just message me normally and I'll relay it to your agent.",
  "",
  "Commands:",
  "/status — check your connection",
  "/disconnect — unlink this chat",
  "/help — show this message",
].join("\n");

function sessionKeyFor(chatId: number): string {
  return `tg-${chatId}`;
}

export async function handleUpdate(update: TelegramUpdate, deps: DispatchDeps): Promise<void> {
  const msg = extractMessage(update);
  if (!msg) return;
  const { chatId, text } = msg;
  const cmd = parseCommand(text);

  if (cmd) {
    switch (cmd.command) {
      case "start":
        return handleStart(chatId, cmd.arg, msg.who, deps);
      case "help":
        return void (await deps.sendMessage(chatId, HELP_TEXT));
      case "status": {
        const link = deps.links.get(chatId);
        return void (await deps.sendMessage(
          chatId,
          link
            ? `✅ Connected — this chat is linked to your agent "${link.tenantId}". Send a message to chat with it.`
            : "Not connected yet. Open the Connect link from your Zynd dashboard and tap Start.",
        ));
      }
      case "disconnect": {
        const removed = deps.links.delete(chatId);
        return void (await deps.sendMessage(
          chatId,
          removed
            ? "Disconnected. This chat is no longer linked. Use a fresh Connect link to reconnect."
            : "This chat wasn't linked to any agent.",
        ));
      }
      default:
        return void (await deps.sendMessage(chatId, `Unknown command /${cmd.command}. Send /help to see what I can do.`));
    }
  }

  const link = deps.links.get(chatId);
  if (!link) {
    await deps.sendMessage(
      chatId,
      "This chat isn't connected to an agent yet. Open the Connect link from your Zynd dashboard, then tap Start.",
    );
    return;
  }

  const agent = await deps.resolveAgent(link.tenantId);
  if (!agent) {
    await deps.sendMessage(
      chatId,
      "Your agent isn't reachable right now. Make sure it's running in your Zynd dashboard, then try again.",
    );
    return;
  }

  // Telegram's typing action lasts ~5s; refresh every 4s while the agent works.
  let typing: ReturnType<typeof setInterval> | undefined;
  if (deps.sendTyping) {
    const tick = () => void deps.sendTyping!(chatId).catch(() => undefined);
    tick();
    typing = setInterval(tick, 4000);
  }
  try {
    const reply = await deps.askAgent(agent, sessionKeyFor(chatId), text);
    await deps.sendMessage(chatId, reply.trim() || "(your agent returned an empty response)");
  } catch {
    await deps.sendMessage(chatId, "Sorry — I couldn't reach your agent just now. Please try again in a moment.");
  } finally {
    if (typing) clearInterval(typing);
  }
}

async function handleStart(
  chatId: number,
  arg: string,
  who: string | undefined,
  deps: DispatchDeps,
): Promise<void> {
  if (!arg) {
    const existing = deps.links.get(chatId);
    await deps.sendMessage(
      chatId,
      existing
        ? `You're already connected to your agent "${existing.tenantId}". Just send a message.`
        : "Welcome to Hermes Zynd 🦅 — to link this chat to your agent, open the Connect link from your Zynd dashboard.",
    );
    return;
  }

  const tenantId = deps.consumeToken(arg);
  if (!tenantId) {
    await deps.sendMessage(
      chatId,
      "That connect link is invalid or has expired. Generate a fresh one from your Zynd dashboard.",
    );
    return;
  }

  const now = deps.now ?? Date.now;
  const link: ChatLink = {
    chatId,
    tenantId,
    linkedAt: new Date(now()).toISOString(),
    ...(who ? { who } : {}),
  };
  deps.links.put(link);
  await deps.sendMessage(
    chatId,
    `✅ Connected! This chat is now linked to your Hermes agent. Send me anything and I'll pass it straight to your agent.`,
  );
}

export const HELP = HELP_TEXT;
