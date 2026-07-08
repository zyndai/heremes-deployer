// Thin wrapper around the `age` binary for encrypting per-agent secrets at
// rest. We shell out rather than binding a JS age library so the format
// stays interoperable with the stock `age` CLI operators already know.
//
// Requires `age` and `age-keygen` on PATH. See infra/install.sh.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { getPersonality } from "@hermes/provisioner/presets";

import { config as cfg, HERMES_UID, HERMES_GID } from "./config";

interface AgeResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

function runAge(args: string[], stdin: Buffer | string): Promise<AgeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("age", args, { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout: Buffer.concat(chunks), stderr, code: code ?? 1 }),
    );

    child.stdin.end(stdin);
  });
}

// Cheap probe so tests can skip the suite when age isn't installed.
export function ageAvailable(): boolean {
  return (
    spawnSync("age", ["--version"]).status === 0 &&
    spawnSync("age-keygen", ["--version"]).status === 0
  );
}

// Read the master age identity (private) and derive the recipient line
// (public) so we don't have to keep both on disk.
export async function readIdentity(
  identityPath: string = cfg.ageIdentityPath,
): Promise<{ identity: string; recipient: string }> {
  const raw = await readFile(identityPath, "utf8");
  const lines = raw.split(/\r?\n/);
  // age-keygen emits "AGE-SECRET-KEY-..." for the identity and a
  // "# public key: age1..." comment for the recipient.
  const identityLine = lines.find((l) => l.startsWith("AGE-SECRET-KEY-"));
  const recipientLine = lines
    .find((l) => l.startsWith("# public key:"))
    ?.replace("# public key:", "")
    .trim();

  if (!identityLine || !recipientLine) {
    throw new Error(
      `Age identity at ${identityPath} is malformed; regenerate with \`age-keygen -o <path>\``,
    );
  }
  return { identity: identityLine, recipient: recipientLine };
}

export async function encryptToFile(
  data: Buffer,
  outPath: string,
  identityPath: string = cfg.ageIdentityPath,
): Promise<void> {
  const { recipient } = await readIdentity(identityPath);
  const { stderr, code } = await runAge(
    ["--encrypt", "--recipient", recipient, "--output", outPath],
    data,
  );
  if (code !== 0) {
    // Never surface argv/recipient — only daemon stderr (spec §5).
    throw new Error(`age encrypt failed (${code}): ${stderr}`);
  }
}

export async function decryptFile(
  inPath: string,
  identityPath: string = cfg.ageIdentityPath,
): Promise<Buffer> {
  // SECURITY: pass the identity as a FILE (--identity <path>), never on
  // argv. argv is world-readable via /proc/<pid>/cmdline, so an inline
  // secret key would leak to any local process.
  const encrypted = await readFile(inPath);
  const { stdout, stderr, code } = await runAge(
    ["--decrypt", "--identity", identityPath],
    encrypted,
  );
  if (code !== 0) {
    throw new Error(`age decrypt failed (${code}): ${stderr}`);
  }
  return stdout;
}

interface SecretFileOpts {
  dataRoot?: string;
  identityPath?: string;
}

// <dataRoot>/secrets/<agentId>.age — the path stored as Agent.secretRef.
function secretPath(agentId: string, dataRoot: string = cfg.dataRoot): string {
  return join(dataRoot, "secrets", `${agentId}.age`);
}

// age-encrypt the agent's secret env ({API_SERVER_KEY, <LLM key>}) JSON to
// disk and return the path. The plaintext never hits disk — only the
// ciphertext file is written (spec §5).
export async function writeSecret(
  agentId: string,
  payload: Record<string, string>,
  opts: SecretFileOpts = {},
): Promise<string> {
  const dataRoot = opts.dataRoot ?? cfg.dataRoot;
  const out = secretPath(agentId, dataRoot);
  await mkdir(join(dataRoot, "secrets"), { recursive: true });
  await encryptToFile(
    Buffer.from(JSON.stringify(payload), "utf8"),
    out,
    opts.identityPath ?? cfg.ageIdentityPath,
  );
  return out;
}

// Decrypt the per-agent secret file and parse it back to the env record.
// Used at the `starting` transition; the result is injected as container
// Env and never persisted.
export async function readSecret(
  agentId: string,
  opts: SecretFileOpts = {},
): Promise<Record<string, string>> {
  const dataRoot = opts.dataRoot ?? cfg.dataRoot;
  const buf = await decryptFile(
    secretPath(agentId, dataRoot),
    opts.identityPath ?? cfg.ageIdentityPath,
  );
  return JSON.parse(buf.toString("utf8")) as Record<string, string>;
}

// Remove the secret file on agent teardown. ENOENT is swallowed so cleanup
// is idempotent (the reverse-order rollback in §5 may run it twice).
export async function deleteSecret(
  agentId: string,
  opts: Pick<SecretFileOpts, "dataRoot"> = {},
): Promise<void> {
  const dataRoot = opts.dataRoot ?? cfg.dataRoot;
  await rm(secretPath(agentId, dataRoot), { force: true });
}

// 24 random bytes -> 48 hex chars. Used as API_SERVER_KEY in the per-agent
// secret; rotated only by recreating the agent.
export function generateApiKey(): string {
  return randomBytes(24).toString("hex");
}

export type LlmProvider = "openrouter" | "anthropic" | "cloudflare";

// Default ZYND memory-layer origin, used when the per-agent secret does not pin
// one (secret.ZYND_MEMORY_URL). The deployer web writes the URL it used for the
// OAuth exchange, so this is only a fallback for older/hand-seeded secrets.
export const DEFAULT_ZYND_MEMORY_URL = "https://api.zynd.ai";

// Provider -> the env var the Hermes image reads its LLM key from.
// anthropic uses the native ANTHROPIC_API_KEY; everything else routes
// through OpenRouter (spec §4).
function providerKeyName(provider: LlmProvider): string {
  // CLOUDFLARE_API_KEY (not _TOKEN): the Hermes image's host-derived key
  // lookup resolves api.cloudflare.com → CLOUDFLARE_API_KEY, and the seeded
  // config.yaml's key_env names the same var — one name end to end.
  if (provider === "cloudflare") return "CLOUDFLARE_API_KEY";
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY";
}

export interface BuildAgentEnvOpts {
  secret: Record<string, string>;
  llmProvider: LlmProvider;
  personalityId?: string;
}

// Personality presets boot the same image with a different system prompt
// (and optionally a model override) injected purely via env.
function personalityEnv(personalityId: string | undefined): Record<string, string> {
  const preset = personalityId ? getPersonality(personalityId) : undefined;
  if (!preset) return {};
  const env: Record<string, string> = {
    HERMES_EPHEMERAL_SYSTEM_PROMPT: preset.systemPrompt,
  };
  if (preset.model) env.HERMES_MODEL = preset.model;
  return env;
}

// Assemble the full container Env for one agent: API server key + the
// provider's LLM key (both from the decrypted secret), the fixed
// API/dashboard flags, the default model, and optional personality env.
// Pure function — no Docker, no encryption — so the lifecycle can call it
// right after readSecret() at the `starting` transition (spec §4/§5).
export function buildAgentEnv(opts: BuildAgentEnvOpts): Record<string, string> {
  const keyName = providerKeyName(opts.llmProvider);
  const llmKey = opts.secret[keyName];
  if (!llmKey) {
    // Scrubbed: name the missing env var, never echo the secret contents.
    throw new Error(`secret is missing ${keyName} for provider ${opts.llmProvider}`);
  }

  const apiServerKey = opts.secret.API_SERVER_KEY;
  if (!apiServerKey) {
    throw new Error("secret is missing API_SERVER_KEY");
  }

  // HERMES_MODEL is ignored by the gateway chat path (config.yaml wins) but
  // dashboard TUI sessions still honor it — so it MUST match the provider the
  // seeded config.yaml routes to, or TUI chats send a foreign model id to the
  // wrong endpoint (e.g. deepseek/* to Workers AI → 402 unified-billing error).
  const modelEnv =
    opts.llmProvider === "cloudflare"
      ? { HERMES_MODEL: cfg.cfDefaultModel }
      : opts.llmProvider === "openrouter"
        ? { HERMES_MODEL: cfg.defaultModel }
        : {}; // anthropic: the image's own Anthropic default is correct

  return {
    API_SERVER_KEY: apiServerKey,
    [keyName]: llmKey,
    API_SERVER_ENABLED: "true",
    API_SERVER_HOST: "0.0.0.0",
    // Drop the gateway to this uid:gid (official compose sets both). Must match
    // the owner of the host data bind so /opt/data is writable; see lifecycle.
    HERMES_UID: String(HERMES_UID),
    HERMES_GID: String(HERMES_GID),
    ...modelEnv,
    HERMES_DASHBOARD: "1",
    // Bind to all interfaces inside the container so the published
    // loopback port is reachable; the host binding stays 127.0.0.1.
    HERMES_DASHBOARD_HOST: "0.0.0.0",
    HERMES_DASHBOARD_TUI: "1",
    // Pin the dashboard's WS session token so it survives a dashboard restart.
    // Unset, the image regenerates it on every (s6-supervised) restart, which
    // invalidates the token already embedded in the open SPA → the chat/event
    // WebSockets close with 1006 ("session ended"). Derived from API_SERVER_KEY
    // (not equal to it: the token is injected into the page HTML, so reusing the
    // API key verbatim would leak it). Stable across redeploys since the key is.
    HERMES_DASHBOARD_SESSION_TOKEN: createHash("sha256")
      .update(`${apiServerKey}:dashboard-ws`)
      .digest("hex"),
    // Without an allowlist the gateway denies "unauthorized" users, which kills
    // dashboard chat sessions ("session ended"). Open access is safe here: the
    // dashboard is already owner-gated at Caddy (forward_auth), so the gateway
    // is not the trust boundary. Without this, the web dashboard cannot chat.
    GATEWAY_ALLOW_ALL_USERS: "true",
    // Dashboard's own OAuth is skipped; auth is enforced at Caddy (§5).
    HERMES_DASHBOARD_INSECURE: "1",
    // ZYND memory-layer credentials for a persona-linked agent. The token
    // authenticates the container's ingest tee and the config.yaml MCP server
    // (bearer-scoped to the owner's ZYND user). Present only after the owner
    // completes "Connect Zynd Persona"; absent for unlinked agents.
    ...(opts.secret.ZYND_MEMORY_TOKEN
      ? {
          ZYND_MEMORY_TOKEN: opts.secret.ZYND_MEMORY_TOKEN,
          ZYND_MEMORY_URL: opts.secret.ZYND_MEMORY_URL || DEFAULT_ZYND_MEMORY_URL,
        }
      : {}),
    // Spread last so a preset model override wins over the default.
    ...personalityEnv(opts.personalityId),
  };
}

// JSON string literals are valid YAML double-quoted scalars, so this safely
// embeds operator/user-supplied values (model ids, account ids) in the seed.
function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

// Marker-delimited region so the worker owns EXACTLY this slice of config.yaml
// and can rewrite it idempotently (token rotation on reconnect) without
// disturbing the gateway's own keys or operator edits. See ensureZyndMcpConfig.
export const ZYND_MCP_BEGIN = "# >>> zynd mcp (managed by hermes-deployer — edits overwritten)";
export const ZYND_MCP_END = "# <<< zynd mcp";

/**
 * The `mcp_servers.zynd` block that wires the agent to the memory-layer MCP
 * server (remember + get_my_context tools), authenticated with the owner's ZYND
 * token. The token VALUE is inlined (not a `${ENV}` ref) so it works regardless
 * of whether the pinned Hermes image interpolates env vars inside config.yaml —
 * an unverified upstream behavior. This matches the existing threat model: the
 * bind dir already stores the Telegram bot token in plaintext at /opt/data/.env
 * and is 0700/0770 (worker + container uid only).
 *
 * ASSUMPTION (verify against the pinned image): Hermes reads a top-level
 * `mcp_servers:` map of {name: {url, headers}} and auto-registers its tools.
 */
export function buildZyndMcpBlock(memoryUrl: string, token: string): string {
  const base = memoryUrl.replace(/\/+$/, "");
  return [
    ZYND_MCP_BEGIN,
    "mcp_servers:",
    "  zynd:",
    `    url: ${yamlQuote(`${base}/mcp`)}`,
    "    headers:",
    `      Authorization: ${yamlQuote(`Bearer ${token}`)}`,
    ZYND_MCP_END,
    "",
  ].join("\n");
}

/**
 * Splice `block` into an existing config.yaml, replacing any prior managed
 * region so a rotated token is refreshed. Pure (no I/O) for testability.
 *
 * Returns the new file contents, or `null` when merging is unsafe — a foreign
 * top-level `mcp_servers:` already exists outside our markers, so appending
 * ours would create a duplicate YAML key. Returns the input unchanged when the
 * block is already present with the same token (caller skips the write).
 */
export function mergeZyndMcpBlock(existing: string, block: string): string | null {
  const begin = existing.indexOf(ZYND_MCP_BEGIN);
  if (begin !== -1) {
    const endIdx = existing.indexOf(ZYND_MCP_END, begin);
    if (endIdx === -1) {
      // Truncated/corrupt managed region — replace from the marker to EOF.
      return existing.slice(0, begin).trimEnd() + "\n\n" + block;
    }
    const after = existing.slice(endIdx + ZYND_MCP_END.length);
    return existing.slice(0, begin) + block.trimEnd() + after;
  }
  // A foreign top-level mcp_servers key means we must not append our own.
  if (/^mcp_servers:/m.test(existing)) return null;
  const trimmed = existing.trimEnd();
  return (trimmed ? trimmed + "\n\n" : "") + block;
}

/**
 * Seed config.yaml for a fresh agent. The current Hermes image ignores the
 * HERMES_MODEL / provider env vars — model and provider come exclusively from
 * HERMES_HOME/config.yaml — so the worker seeds the file before first boot
 * (the image's bootstrap merges around an existing file rather than
 * replacing it; verified live 2026-06-11).
 *
 * - cloudflare: named custom provider pointing at the account's Workers AI
 *   OpenAI-compatible endpoint; the key is read at request time from the
 *   CLOUDFLARE_API_KEY env var buildAgentEnv injects.
 * - openrouter: pin model.default so DEPLOYER_DEFAULT_MODEL takes effect.
 * - anthropic: return null — the image auto-detects ANTHROPIC_API_KEY and
 *   its own default model is an Anthropic id, so no seed is needed.
 *
 * @throws for cloudflare when the secret lacks CF_ACCOUNT_ID — the endpoint
 *   URL embeds the account id, so deploying without it can never work.
 */
export function buildAgentConfigYaml(opts: {
  llmProvider: LlmProvider;
  secret: Record<string, string>;
}): string | null {
  if (opts.llmProvider === "cloudflare") {
    const accountId = opts.secret.CF_ACCOUNT_ID;
    if (!accountId) {
      throw new Error("secret is missing CF_ACCOUNT_ID for provider cloudflare");
    }
    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
    const model = cfg.cfDefaultModel;
    return [
      "model:",
      "  provider: cloudflare",
      `  default: ${yamlQuote(model)}`,
      "providers:",
      "  cloudflare:",
      "    name: cloudflare",
      `    base_url: ${yamlQuote(baseUrl)}`,
      "    key_env: CLOUDFLARE_API_KEY",
      "    api_mode: chat_completions",
      `    default_model: ${yamlQuote(model)}`,
      "",
    ].join("\n");
  }

  if (opts.llmProvider === "openrouter") {
    return [
      "model:",
      "  provider: auto",
      `  default: ${yamlQuote(cfg.defaultModel)}`,
      `  base_url: "https://openrouter.ai/api/v1"`,
      "",
    ].join("\n");
  }

  return null;
}
