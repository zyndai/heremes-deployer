import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveCloudflareAccountId, CloudflareAccountError } from "../src/lib/cloudflare.js";

function mockFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("resolveCloudflareAccountId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the single account's id when the token maps to exactly one", async () => {
    // #given a token whose /accounts listing returns one account
    mockFetch(() => jsonResponse({ result: [{ id: "ff19753281ef97f7fd11923a2e69160d" }] }));
    // #when resolved
    const id = await resolveCloudflareAccountId("cfut_token");
    // #then that account id comes back
    expect(id).toBe("ff19753281ef97f7fd11923a2e69160d");
  });

  it("throws when the token can access multiple accounts", async () => {
    // #given a token with two accessible accounts
    mockFetch(() => jsonResponse({ result: [{ id: "a".repeat(32) }, { id: "b".repeat(32) }] }));
    // #when/#then it refuses to guess
    await expect(resolveCloudflareAccountId("cfut_token")).rejects.toBeInstanceOf(CloudflareAccountError);
  });

  it("throws when no account is returned", async () => {
    mockFetch(() => jsonResponse({ result: [] }));
    await expect(resolveCloudflareAccountId("cfut_token")).rejects.toBeInstanceOf(CloudflareAccountError);
  });

  it("throws when the token cannot list accounts (403)", async () => {
    mockFetch(() => jsonResponse({ success: false }, false, 403));
    await expect(resolveCloudflareAccountId("cfut_token")).rejects.toBeInstanceOf(CloudflareAccountError);
  });

  it("throws a recoverable error on a network failure", async () => {
    mockFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(resolveCloudflareAccountId("cfut_token")).rejects.toBeInstanceOf(CloudflareAccountError);
  });
});
