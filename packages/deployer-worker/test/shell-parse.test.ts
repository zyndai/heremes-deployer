import { describe, it, expect } from "vitest";

// shell.ts imports docker.ts (real dockerode + config), which requires
// HERMES_IMAGE at load — stub before importing, same as ws-parse.test.ts.
process.env.HERMES_IMAGE ??= "ghcr.io/test/hermes:latest";

const { parseShellPath } = await import("../src/shell.js");

describe("parseShellPath", () => {
  it("parses a valid shell path with token", () => {
    // #given the documented shell URL
    const out = parseShellPath("/v1/agents/agent_abc/shell?token=tok123");

    // #then agentId and token are extracted
    expect(out).toEqual({ agentId: "agent_abc", token: "tok123" });
  });

  it("url-decodes the agentId segment", () => {
    // #given an encoded id
    const out = parseShellPath("/v1/agents/a%2Fb/shell?token=t");

    // #then it is decoded
    expect(out?.agentId).toBe("a/b");
  });

  it("returns null when the token is missing", () => {
    // #given no token query param
    const out = parseShellPath("/v1/agents/agent_abc/shell");

    // #then parse fails
    expect(out).toBeNull();
  });

  it("returns null for the wrong path shape", () => {
    // #given the deploy path from the OTHER handler on this same server
    expect(parseShellPath("/v1/agents/agent_abc/deploy?token=t")).toBeNull();
    // #and a too-short path
    expect(parseShellPath("/v1/agents/shell?token=t")).toBeNull();
    // #and undefined
    expect(parseShellPath(undefined)).toBeNull();
  });

  it("returns null when agentId is empty", () => {
    // #given an empty id segment
    expect(parseShellPath("/v1/agents//shell?token=t")).toBeNull();
  });
});
