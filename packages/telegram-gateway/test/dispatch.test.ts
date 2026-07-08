import { describe, it, expect, beforeEach } from "vitest";
import { handleUpdate, type DispatchDeps } from "../src/dispatch";
import type { ChatLink, TelegramUpdate, AgentEndpoint } from "../src/types";

function makeDeps(overrides: Partial<DispatchDeps> = {}) {
  const links = new Map<number, ChatLink>();
  const sent: Array<{ chatId: number; text: string }> = [];
  const asked: Array<{ agent: AgentEndpoint; sessionKey: string; text: string }> = [];
  const validTokens = new Map<string, string>([["good-token", "tenant-1"]]);

  const deps: DispatchDeps = {
    botUsername: "HermesZyndBot",
    links: {
      get: (c) => links.get(c),
      put: (l) => void links.set(l.chatId, l),
      delete: (c) => links.delete(c),
    },
    consumeToken: (t) => {
      const tenant = validTokens.get(t);
      if (!tenant) return null;
      validTokens.delete(t);
      return tenant;
    },
    sendMessage: async (chatId, text) => void sent.push({ chatId, text }),
    resolveAgent: async (tenantId) => ({ baseUrl: `http://localhost:9000/${tenantId}`, apiKey: "k" }),
    askAgent: async (agent, sessionKey, text) => {
      asked.push({ agent, sessionKey, text });
      return `echo: ${text}`;
    },
    ...overrides,
  };
  return { deps, links, sent, asked };
}

function msg(chatId: number, text: string): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, text, chat: { id: chatId }, from: { id: 5, username: "sahil" } } };
}

describe("handleUpdate — connect flow", () => {
  it("links the chat on /start <valid token>", async () => {
    const { deps, links, sent } = makeDeps();
    await handleUpdate(msg(100, "/start good-token"), deps);
    expect(links.get(100)?.tenantId).toBe("tenant-1");
    expect(links.get(100)?.who).toBe("sahil");
    expect(sent.at(-1)?.text).toMatch(/Connected/i);
  });

  it("rejects an invalid/expired token and does not link", async () => {
    const { deps, links, sent } = makeDeps();
    await handleUpdate(msg(101, "/start bad-token"), deps);
    expect(links.get(101)).toBeUndefined();
    expect(sent.at(-1)?.text).toMatch(/invalid or has expired/i);
  });

  it("burns the token so a replayed link fails", async () => {
    const { deps, sent } = makeDeps();
    await handleUpdate(msg(102, "/start good-token"), deps);
    await handleUpdate(msg(103, "/start good-token"), deps);
    expect(sent.at(-1)?.text).toMatch(/invalid or has expired/i);
  });

  it("prompts to connect when an unlinked chat sends a plain message", async () => {
    const { deps, sent, asked } = makeDeps();
    await handleUpdate(msg(200, "hello?"), deps);
    expect(asked).toHaveLength(0);
    expect(sent.at(-1)?.text).toMatch(/isn't connected/i);
  });
});

describe("handleUpdate — messaging a linked agent", () => {
  beforeEach(() => {});

  it("relays a plain message to the agent and returns the reply", async () => {
    const { deps, links, sent, asked } = makeDeps();
    links.set(300, { chatId: 300, tenantId: "tenant-1", linkedAt: "x" });
    await handleUpdate(msg(300, "what's the weather"), deps);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.sessionKey).toBe("tg-300");
    expect(asked[0]?.text).toBe("what's the weather");
    expect(sent.at(-1)?.text).toBe("echo: what's the weather");
  });

  it("tells the user when the agent is unreachable", async () => {
    const { deps, links, sent } = makeDeps({ resolveAgent: async () => null });
    links.set(301, { chatId: 301, tenantId: "tenant-1", linkedAt: "x" });
    await handleUpdate(msg(301, "ping"), deps);
    expect(sent.at(-1)?.text).toMatch(/isn't reachable/i);
  });

  it("falls back gracefully when the agent call throws", async () => {
    const { deps, links, sent } = makeDeps({
      askAgent: async () => {
        throw new Error("boom");
      },
    });
    links.set(302, { chatId: 302, tenantId: "tenant-1", linkedAt: "x" });
    await handleUpdate(msg(302, "ping"), deps);
    expect(sent.at(-1)?.text).toMatch(/couldn't reach your agent/i);
  });
});

describe("handleUpdate — ZYND ingest tee", () => {
  it("tees the user turn to ingest, keyed by tenantId, for a linked chat", async () => {
    // #given a linked chat and an ingest spy
    const ingested: Array<{ agent: AgentEndpoint; conversationId: string; text: string }> = [];
    const { deps, links } = makeDeps({
      ingest: (agent, conversationId, text) => void ingested.push({ agent, conversationId, text }),
    });
    links.set(500, { chatId: 500, tenantId: "tenant-1", linkedAt: "x" });

    // #when the user sends a message
    await handleUpdate(msg(500, "I'm building a memory layer"), deps);

    // #then exactly one turn is teed, keyed by tenant, with the raw text
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.conversationId).toBe("tenant-1");
    expect(ingested[0]?.text).toBe("I'm building a memory layer");
  });

  it("does not tee for an unlinked chat", async () => {
    // #given no link and an ingest spy
    const ingested: unknown[] = [];
    const { deps } = makeDeps({ ingest: () => void ingested.push(1) });

    // #when an unlinked chat messages
    await handleUpdate(msg(501, "hello"), deps);

    // #then nothing is ingested (no owner to attribute it to)
    expect(ingested).toHaveLength(0);
  });

  it("still captures the turn even if the agent reply fails", async () => {
    // #given ingest runs before the relay, which throws
    const ingested: unknown[] = [];
    const { deps, links } = makeDeps({
      ingest: () => void ingested.push(1),
      askAgent: async () => {
        throw new Error("boom");
      },
    });
    links.set(502, { chatId: 502, tenantId: "tenant-1", linkedAt: "x" });

    // #when the user messages and the agent call fails
    await handleUpdate(msg(502, "remember this"), deps);

    // #then the turn was still captured
    expect(ingested).toHaveLength(1);
  });
});

describe("handleUpdate — commands", () => {
  it("/status reflects connection state", async () => {
    const { deps, links, sent } = makeDeps();
    await handleUpdate(msg(400, "/status"), deps);
    expect(sent.at(-1)?.text).toMatch(/Not connected/i);
    links.set(400, { chatId: 400, tenantId: "tenant-9", linkedAt: "x" });
    await handleUpdate(msg(400, "/status"), deps);
    expect(sent.at(-1)?.text).toMatch(/tenant-9/);
  });

  it("/disconnect removes a link", async () => {
    const { deps, links, sent } = makeDeps();
    links.set(401, { chatId: 401, tenantId: "t", linkedAt: "x" });
    await handleUpdate(msg(401, "/disconnect"), deps);
    expect(links.get(401)).toBeUndefined();
    expect(sent.at(-1)?.text).toMatch(/Disconnected/i);
  });

  it("/help explains the bot", async () => {
    const { deps, sent } = makeDeps();
    await handleUpdate(msg(402, "/help"), deps);
    expect(sent.at(-1)?.text).toMatch(/Hermes Zynd/);
  });
});
