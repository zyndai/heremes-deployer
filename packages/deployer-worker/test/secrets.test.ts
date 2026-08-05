import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// secrets.ts imports the real config module, which fails fast at load if
// HERMES_IMAGE is unset. Stub it before the static import is evaluated.
vi.hoisted(() => {
  process.env.HERMES_IMAGE ??= "ghcr.io/acme/hermes:test";
});

import {
  ageAvailable,
  buildAgentConfigYaml,
  buildAgentEnv,
  buildZyndMcpBlock,
  mergeZyndMcpBlock,
  decryptFile,
  deleteSecret,
  encryptToFile,
  readIdentity,
  readSecret,
  writeSecret,
  DEFAULT_ZYND_MEMORY_URL,
  ZYND_MCP_BEGIN,
} from "../src/secrets.js";

describe("buildAgentEnv (cloudflare)", () => {
  it("maps cloudflare provider to CLOUDFLARE_API_KEY", () => {
    // #given a secret holding a Cloudflare token
    const secret = { API_SERVER_KEY: "k-server", CLOUDFLARE_API_KEY: "cfut-x" };

    // #when building the env
    const env = buildAgentEnv({ secret, llmProvider: "cloudflare" });

    // #then the token is injected under the name the seeded config's key_env reads
    expect(env.CLOUDFLARE_API_KEY).toBe("cfut-x");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("pins HERMES_MODEL to the cloudflare default, not the openrouter default", () => {
    // #given a cloudflare agent
    const secret = { API_SERVER_KEY: "k-server", CLOUDFLARE_API_KEY: "cfut-x" };

    // #when building the env
    const env = buildAgentEnv({ secret, llmProvider: "cloudflare" });

    // #then TUI sessions (which honor HERMES_MODEL) get a @cf/ model the
    // Workers AI endpoint can serve — a partner-prefixed id would 402
    expect(env.HERMES_MODEL).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("omits HERMES_MODEL for anthropic (image default is already an Anthropic id)", () => {
    // #given an anthropic agent
    const secret = { API_SERVER_KEY: "k-server", ANTHROPIC_API_KEY: "sk-ant-y" };

    // #when building the env
    const env = buildAgentEnv({ secret, llmProvider: "anthropic" });

    // #then no cross-provider model id is injected
    expect(env.HERMES_MODEL).toBeUndefined();
  });
});

describe("buildAgentConfigYaml", () => {
  it("builds a cloudflare provider block with the account-scoped endpoint", () => {
    // #given a cloudflare secret with the account id
    const yaml = buildAgentConfigYaml({
      llmProvider: "cloudflare",
      secret: { CLOUDFLARE_API_KEY: "cfut-x", CF_ACCOUNT_ID: "a".repeat(32) },
    });

    // #then the seed pins provider, model, endpoint, and env-var key source
    expect(yaml).toContain("provider: cloudflare");
    expect(yaml).toContain(
      `base_url: "https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/v1"`,
    );
    expect(yaml).toContain("key_env: CLOUDFLARE_API_KEY");
    expect(yaml).toContain('default: "@cf/meta/llama-3.3-70b-instruct-fp8-fast"');
  });

  it("throws for cloudflare when CF_ACCOUNT_ID is missing", () => {
    // #then the deploy fails loudly instead of building a broken endpoint URL
    expect(() =>
      buildAgentConfigYaml({ llmProvider: "cloudflare", secret: { CLOUDFLARE_API_KEY: "x" } }),
    ).toThrow(/CF_ACCOUNT_ID/);
  });

  it("pins the default model for openrouter so DEPLOYER_DEFAULT_MODEL takes effect", () => {
    // #when building the openrouter seed
    const yaml = buildAgentConfigYaml({ llmProvider: "openrouter", secret: {} });

    // #then model.default carries the worker's configured default
    expect(yaml).toContain('default: "deepseek/deepseek-v4-flash"');
    expect(yaml).toContain('base_url: "https://openrouter.ai/api/v1"');
  });

  it("returns null for anthropic (image auto-detects the key)", () => {
    // #then no seed is written for anthropic agents
    expect(buildAgentConfigYaml({ llmProvider: "anthropic", secret: {} })).toBeNull();
  });
});

// age/age-keygen are provisioned by infra/install.sh. On a dev box without
// them the round-trip can't run, so skip rather than fail the suite.
const hasAge = ageAvailable();
const d = hasAge ? describe : describe.skip;

let tmp: string;
let identityPath: string;

beforeAll(async () => {
  if (!hasAge) return;
  tmp = await mkdtemp(join(tmpdir(), "hermes-secrets-"));
  identityPath = join(tmp, "master.age");
  const gen = spawnSync("age-keygen", ["-o", identityPath], { encoding: "utf8" });
  if (gen.status !== 0) {
    throw new Error(`age-keygen failed: ${gen.stderr}`);
  }
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

d("age primitives", () => {
  it("derives a recipient from the identity file", async () => {
    const { identity, recipient } = await readIdentity(identityPath);
    expect(identity.startsWith("AGE-SECRET-KEY-")).toBe(true);
    expect(recipient.startsWith("age1")).toBe(true);
  });

  it("encrypts a buffer to a file then decrypts it back", async () => {
    const plaintext = Buffer.from("super-secret-value", "utf8");
    const out = join(tmp, "blob.age");
    await encryptToFile(plaintext, out, identityPath);
    const onDisk = await readFile(out, "utf8");
    const back = await decryptFile(out, identityPath);
    expect(onDisk.startsWith("age-encryption.org/v1")).toBe(true);
    expect(onDisk).not.toContain("super-secret-value");
    expect(back.toString("utf8")).toBe("super-secret-value");
  });

  it("throws a scrubbed error on a malformed identity file", async () => {
    const bad = join(tmp, "bad.age");
    await writeFile(bad, "not an identity\n", "utf8");
    await expect(readIdentity(bad)).rejects.toThrow(/malformed/);
  });
});

d("per-agent secret file", () => {
  const agentId = "agent_abc123";
  const payload = {
    API_SERVER_KEY: "deadbeefdeadbeefdeadbeef",
    OPENROUTER_API_KEY: "sk-or-v1-topsecret",
  };

  it("writeSecret -> readSecret round-trips the payload", async () => {
    const path = await writeSecret(agentId, payload, { dataRoot: tmp, identityPath });
    const back = await readSecret(agentId, { dataRoot: tmp, identityPath });
    expect(path).toBe(join(tmp, "secrets", `${agentId}.age`));
    expect(back).toEqual(payload);
  });

  it("never writes the plaintext key to the .age file", async () => {
    const path = await writeSecret(agentId, payload, { dataRoot: tmp, identityPath });
    const onDisk = await readFile(path, "utf8");
    expect(onDisk.startsWith("age-encryption.org/v1")).toBe(true);
    expect(onDisk).not.toContain("sk-or-v1-topsecret");
    expect(onDisk).not.toContain("deadbeefdeadbeefdeadbeef");
  });

  it("deleteSecret removes the file and is idempotent on ENOENT", async () => {
    await writeSecret(agentId, payload, { dataRoot: tmp, identityPath });
    await deleteSecret(agentId, { dataRoot: tmp });
    await expect(readSecret(agentId, { dataRoot: tmp, identityPath })).rejects.toThrow();
    await expect(deleteSecret(agentId, { dataRoot: tmp })).resolves.toBeUndefined();
  });
});

describe("buildAgentEnv", () => {
  const base = {
    API_SERVER_KEY: "k-server",
  };

  it("maps openrouter provider to OPENROUTER_API_KEY", () => {
    const secret = { ...base, OPENROUTER_API_KEY: "sk-or-x" };
    const env = buildAgentEnv({ secret, llmProvider: "openrouter" });
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.API_SERVER_KEY).toBe("k-server");
    expect(env.API_SERVER_ENABLED).toBe("true");
    expect(env.API_SERVER_HOST).toBe("0.0.0.0");
    expect(env.GATEWAY_ALLOW_ALL_USERS).toBe("true");
    // Pinned (not random, not equal to the API key which would leak via the
    // injected page) so the dashboard WS token survives a restart.
    expect(env.HERMES_DASHBOARD_SESSION_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(env.HERMES_DASHBOARD_SESSION_TOKEN).not.toBe("k-server");
    expect(env.HERMES_UID).toBe("10000");
    expect(env.HERMES_GID).toBe("10000");
    expect(env.HERMES_DASHBOARD).toBe("1");
    expect(env.HERMES_DASHBOARD_HOST).toBe("0.0.0.0");
    expect(env.HERMES_DASHBOARD_TUI).toBe("1");
    expect(env.HERMES_DASHBOARD_INSECURE).toBe("1");
    expect(env.HERMES_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBeUndefined();
  });

  it("maps anthropic provider to ANTHROPIC_API_KEY", () => {
    const secret = { ...base, ANTHROPIC_API_KEY: "sk-ant-y" };
    const env = buildAgentEnv({ secret, llmProvider: "anthropic" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-y");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("injects personality system prompt and lets a preset model override the default", () => {
    const secret = { ...base, OPENROUTER_API_KEY: "sk-or-x" };
    const env = buildAgentEnv({
      secret,
      llmProvider: "openrouter",
      personalityId: "coding",
    });
    expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toContain("senior software engineer");
    expect(env.HERMES_MODEL).toBe("deepseek/deepseek-v4-flash");
  });

  it("ignores an unknown personalityId (no prompt injected)", () => {
    const secret = { ...base, OPENROUTER_API_KEY: "sk-or-x" };
    const env = buildAgentEnv({
      secret,
      llmProvider: "openrouter",
      personalityId: "does-not-exist",
    });
    expect(env.HERMES_EPHEMERAL_SYSTEM_PROMPT).toBeUndefined();
  });

  it("throws if the secret is missing the provider key", () => {
    expect(() =>
      buildAgentEnv({
        secret: { ...base, OPENROUTER_API_KEY: "sk-or-x" },
        llmProvider: "anthropic",
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("injects ZYND memory env when the secret carries a token", () => {
    // #given a persona-linked secret with a pinned memory URL
    const secret = {
      ...base,
      OPENROUTER_API_KEY: "sk-or-x",
      ZYND_MEMORY_TOKEN: "zynd-tok-123",
      ZYND_MEMORY_URL: "https://api.example.test",
    };

    // #when building the env
    const env = buildAgentEnv({ secret, llmProvider: "openrouter" });

    // #then the container gets both the token and the URL it was linked with
    expect(env.ZYND_MEMORY_TOKEN).toBe("zynd-tok-123");
    expect(env.ZYND_MEMORY_URL).toBe("https://api.example.test");
  });

  it("defaults ZYND_MEMORY_URL when only a token is present", () => {
    // #given a token without an explicit URL
    const secret = { ...base, OPENROUTER_API_KEY: "sk-or-x", ZYND_MEMORY_TOKEN: "zynd-tok-123" };

    // #when building the env
    const env = buildAgentEnv({ secret, llmProvider: "openrouter" });

    // #then the default memory origin is used
    expect(env.ZYND_MEMORY_URL).toBe(DEFAULT_ZYND_MEMORY_URL);
  });

  it("omits ZYND memory env for an unlinked agent", () => {
    // #given a secret with no ZYND token
    const secret = { ...base, OPENROUTER_API_KEY: "sk-or-x" };

    // #when building the env
    const env = buildAgentEnv({ secret, llmProvider: "openrouter" });

    // #then neither ZYND var is present
    expect(env.ZYND_MEMORY_TOKEN).toBeUndefined();
    expect(env.ZYND_MEMORY_URL).toBeUndefined();
  });
});

describe("buildZyndMcpBlock", () => {
  it("emits an mcp_servers block with the /mcp url and bearer header", () => {
    // #when building the block for a linked agent
    const block = buildZyndMcpBlock("https://api.zynd.ai/", "zynd-tok-123");

    // #then it registers the zynd server with a trailing-slash-normalized url
    expect(block).toContain(ZYND_MCP_BEGIN);
    expect(block).toContain("mcp_servers:");
    expect(block).toContain('url: "https://api.zynd.ai/mcp"');
    expect(block).toContain('Authorization: "Bearer zynd-tok-123"');
  });
});

describe("mergeZyndMcpBlock", () => {
  const block = buildZyndMcpBlock("https://api.zynd.ai", "tok-A");

  it("appends the block after an existing provider seed", () => {
    // #given a config.yaml with only the model seed
    const existing = 'model:\n  provider: auto\n  default: "x"\n';

    // #when merging
    const merged = mergeZyndMcpBlock(existing, block);

    // #then the seed is preserved and our block is appended
    expect(merged).not.toBeNull();
    expect(merged).toContain("provider: auto");
    expect(merged).toContain("mcp_servers:");
  });

  it("is idempotent when the same token is already present", () => {
    // #given a config that already holds our current block
    const existing = mergeZyndMcpBlock('model:\n  provider: auto\n', block) as string;

    // #when merging the same block again
    const again = mergeZyndMcpBlock(existing, block);

    // #then the file is unchanged (caller skips the write)
    expect(again).toBe(existing);
  });

  it("replaces a stale token in the managed region (rotation on reconnect)", () => {
    // #given a config holding an OLD token block
    const old = mergeZyndMcpBlock("model:\n  provider: auto\n", buildZyndMcpBlock("https://api.zynd.ai", "tok-OLD")) as string;
    expect(old).toContain("Bearer tok-OLD");

    // #when merging a NEW token block
    const rotated = mergeZyndMcpBlock(old, buildZyndMcpBlock("https://api.zynd.ai", "tok-NEW"));

    // #then the old token is gone and the new one is in, with no duplicate region
    expect(rotated).not.toBeNull();
    expect(rotated).toContain("Bearer tok-NEW");
    expect(rotated).not.toContain("Bearer tok-OLD");
    expect(rotated!.match(/mcp_servers:/g)?.length).toBe(1);
  });

  it("refuses to merge when a foreign mcp_servers key exists", () => {
    // #given a config that already defines its own mcp_servers
    const existing = "mcp_servers:\n  other:\n    url: \"https://x\"\n";

    // #then we return null rather than create a duplicate top-level key
    expect(mergeZyndMcpBlock(existing, block)).toBeNull();
  });

  it("creates a block from empty config", () => {
    // #when merging into an empty file
    const merged = mergeZyndMcpBlock("", block);

    // #then the block is written on its own
    expect(merged).toContain("mcp_servers:");
    expect(merged).toContain("Bearer tok-A");
  });
});
