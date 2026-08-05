import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the Agent row so we exercise the real AES-GCM crypto
// without a database.
let store: Record<string, { secretBlob: string | null }> = {};
const updateMock = vi.fn(async ({ where, data }: { where: { id: string }; data: { secretBlob: string | null } }) => {
  store[where.id] = { secretBlob: data.secretBlob };
  return store[where.id];
});
const findUniqueMock = vi.fn(async ({ where }: { where: { id: string } }) => store[where.id] ?? null);

vi.mock("../src/db", () => ({
  prisma: {
    agent: {
      update: (a: unknown) => updateMock(a as never),
      findUnique: (a: unknown) => findUniqueMock(a as never),
    },
  },
}));

const { writeSecret, readSecret, deleteSecret, generateApiKey } = await import("../src/db-secrets");

// 32 random bytes, base64 — a valid SECRET_ENC_KEY.
const KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
  "utf8",
).toString("base64");

beforeEach(() => {
  store = {};
  updateMock.mockClear();
  findUniqueMock.mockClear();
  process.env.SECRET_ENC_KEY = KEY;
});

afterEach(() => {
  delete process.env.SECRET_ENC_KEY;
});

describe("db-secrets", () => {
  it("round-trips an encrypted payload through the DB blob", async () => {
    // #given a secret payload
    const payload = { API_SERVER_KEY: "srv-key", OPENROUTER_API_KEY: "sk-or-xyz" };

    // #when written then read back
    const ref = await writeSecret("agent-1", payload);
    const out = await readSecret("agent-1");

    // #then the round-trip is lossless and the ref is the db pointer
    expect(out).toEqual(payload);
    expect(ref).toBe("db:agent-1");
  });

  it("stores ciphertext, never the plaintext key", async () => {
    await writeSecret("agent-1", { OPENROUTER_API_KEY: "sk-or-SECRET" });
    const blob = store["agent-1"]!.secretBlob!;
    // #then the persisted blob does not contain the raw key
    expect(blob).not.toContain("sk-or-SECRET");
    expect(blob).not.toContain("OPENROUTER_API_KEY");
  });

  it("rejects a tampered blob (GCM auth tag)", async () => {
    await writeSecret("agent-1", { OPENROUTER_API_KEY: "sk-or-xyz" });
    // flip a byte deep in the ciphertext region
    const buf = Buffer.from(store["agent-1"]!.secretBlob!, "base64");
    const last = buf.length - 1;
    buf[last] = (buf[last] ?? 0) ^ 0xff;
    store["agent-1"] = { secretBlob: buf.toString("base64") };

    await expect(readSecret("agent-1")).rejects.toThrow();
  });

  it("throws a clear error when SECRET_ENC_KEY is missing", async () => {
    delete process.env.SECRET_ENC_KEY;
    await expect(writeSecret("agent-1", { x: "y" })).rejects.toThrow(/SECRET_ENC_KEY/);
  });

  it("throws when the key is the wrong length", async () => {
    process.env.SECRET_ENC_KEY = Buffer.from("too-short", "utf8").toString("base64");
    await expect(writeSecret("agent-1", { x: "y" })).rejects.toThrow(/32 bytes/);
  });

  it("readSecret throws when the agent has no blob", async () => {
    await expect(readSecret("missing")).rejects.toThrow(/no secretBlob/);
  });

  it("deleteSecret nulls the blob and is idempotent", async () => {
    await writeSecret("agent-1", { x: "y" });
    await deleteSecret("agent-1");
    expect(store["agent-1"]!.secretBlob).toBeNull();
    // second call on an already-cleared / unknown row does not throw
    await expect(deleteSecret("agent-1")).resolves.toBeUndefined();
  });

  it("generateApiKey returns 48 hex chars", () => {
    expect(generateApiKey()).toMatch(/^[0-9a-f]{48}$/);
  });
});
