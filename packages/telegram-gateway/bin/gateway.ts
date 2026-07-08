import { AgentStore } from "@hermes/provisioner";
import { DynamoAgentStore } from "@hermes/provisioner/dynamo";
import { loadGatewayConfig } from "../src/config";
import { ConnectTokenStore } from "../src/connect-tokens";
import { ChatLinkStore } from "../src/link-store";
import { TelegramApi, type BotCommand } from "../src/telegram-api";
import { askAgent } from "../src/agent-client";
import { LocalAgentResolver, type AgentResolver } from "../src/agent-resolver";
import { AwsAgentResolver } from "../src/aws-resolver";
import { handleUpdate, type DispatchDeps } from "../src/dispatch";

try {
  process.loadEnvFile();
} catch {
  // no .env present — rely on the ambient environment
}

const BOT_COMMANDS: BotCommand[] = [
  { command: "start", description: "Connect your Hermes agent" },
  { command: "help", description: "What Hermes can do" },
  { command: "status", description: "Check your connection" },
  { command: "disconnect", description: "Unlink this chat from your agent" },
];

async function main(): Promise<void> {
  const cfg = await loadGatewayConfig();

  if (cfg.mode === "webhook") {
    console.error(
      "TELEGRAM_MODE=webhook — this long-polling runner is for local dev.\n" +
        "For production, run `pnpm set-webhook` and serve the webhook endpoint in your web app.",
    );
    process.exit(1);
  }

  const api = new TelegramApi(cfg.botToken);
  const tokens = new ConnectTokenStore(cfg.connectTokensPath);
  const links = new ChatLinkStore(cfg.chatLinksPath);

  const isAws = process.env.HERMES_RUNTIME === "aws";
  let resolver: AgentResolver;
  if (isAws) {
    const region = process.env.AWS_REGION ?? "us-east-1";
    resolver = new AwsAgentResolver(new DynamoAgentStore(region), region);
    console.log("Resolver: AWS (DynamoDB store + Secrets Manager)");
  } else {
    resolver = new LocalAgentResolver(new AgentStore(cfg.storePath));
    console.log("Resolver: local (JSON store + docker inspect)");
  }

  const me = await api.getMe();
  console.log(`🦅 Hermes Zynd gateway online as @${me.username} (id ${me.id})`);
  await api.setMyCommands(BOT_COMMANDS);
  // Webhook and getUpdates are mutually exclusive — clear any stale webhook.
  await api.deleteWebhook();

  const deps: DispatchDeps = {
    botUsername: cfg.botUsername,
    links,
    consumeToken: (t) => tokens.consume(t),
    sendMessage: (chatId, text) => api.sendMessage(chatId, text),
    sendTyping: (chatId) => api.sendChatAction(chatId, "typing"),
    resolveAgent: (tenantId) => resolver.resolve(tenantId),
    askAgent: (agent, sessionKey, text) => askAgent(agent, sessionKey, text, { model: cfg.model }),
  };

  let offset = 0;
  console.log("Polling for messages… (Ctrl-C to stop)");
  for (;;) {
    try {
      const updates = await api.getUpdates(offset, 30);
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        try {
          await handleUpdate(u, deps);
        } catch (err) {
          console.error("handleUpdate error:", err);
        }
      }
    } catch (err) {
      console.error("getUpdates error (retrying in 3s):", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
