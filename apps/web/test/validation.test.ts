import { describe, it, expect } from "vitest";
import { createAgentSchema } from "../src/lib/validation.js";

describe("createAgentSchema", () => {
  it("accepts a valid openrouter body", () => {
    const out = createAgentSchema.safeParse({
      name: "my-agent",
      llmProvider: "openrouter",
      llmKey: "sk-or-abcdefghijklmnop",
    });
    expect(out.success).toBe(true);
  });
  it("rejects an unknown provider", () => {
    const out = createAgentSchema.safeParse({
      name: "x",
      llmProvider: "openai",
      llmKey: "sk-or-abcdefghijklmnop",
    });
    expect(out.success).toBe(false);
  });
  it("rejects a too-short key", () => {
    const out = createAgentSchema.safeParse({
      name: "x",
      llmProvider: "anthropic",
      llmKey: "sk-ant-1",
    });
    expect(out.success).toBe(false);
  });
  it("accepts an optional personalityId", () => {
    const out = createAgentSchema.safeParse({
      name: "x",
      llmProvider: "anthropic",
      llmKey: "sk-ant-abcdefghijklmnop",
      personalityId: "stoic",
    });
    expect(out.success).toBe(true);
  });
  it("accepts a valid cloudflare body (token + 32-hex account id)", () => {
    const out = createAgentSchema.safeParse({
      name: "cf-agent",
      llmProvider: "cloudflare",
      llmKey: "cfut_FESiL4BfEYU8yf8Q2xXHoY8oOT0kPs66",
      cfAccountId: "ff19753281ef97f7fd11923a2e69160d",
    });
    expect(out.success).toBe(true);
  });
  it("accepts cloudflare without an account id (auto-detected from the token)", () => {
    // #given a cloudflare body with a valid token but no account id
    // #when validated — #then it passes; the API resolves the id from the token.
    const out = createAgentSchema.safeParse({
      name: "cf-agent",
      llmProvider: "cloudflare",
      llmKey: "cfut_FESiL4BfEYU8yf8Q2xXHoY8oOT0kPs66",
    });
    expect(out.success).toBe(true);
  });
  it("rejects a malformed cloudflare account id", () => {
    const out = createAgentSchema.safeParse({
      name: "cf-agent",
      llmProvider: "cloudflare",
      llmKey: "cfut_FESiL4BfEYU8yf8Q2xXHoY8oOT0kPs66",
      cfAccountId: "not-a-hex-id",
    });
    expect(out.success).toBe(false);
  });
  it("still requires the sk-or- prefix for openrouter keys", () => {
    const out = createAgentSchema.safeParse({
      name: "x",
      llmProvider: "openrouter",
      llmKey: "cfut_notAnOpenrouterKey123456",
    });
    expect(out.success).toBe(false);
  });
});
