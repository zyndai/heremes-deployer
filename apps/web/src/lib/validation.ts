import { z } from "zod";

// Format sanity checks fail fast before a ~30s container boot; not provider
// validation. Provider chooses the env var name (OPENROUTER_API_KEY vs
// ANTHROPIC_API_KEY vs CLOUDFLARE_API_KEY) the worker injects — see spec §4.
const KEY_PREFIX: Record<string, string> = {
  openrouter: "sk-or-",
  anthropic: "sk-ant-",
};

// Cloudflare API tokens have no stable prefix across generations (cfat_/cfut_
// on new account/user tokens, bare base62 on older ones) — check charset only.
const CF_TOKEN_RE = /^[A-Za-z0-9_-]{30,}$/;

// 32 lowercase hex chars, shown as "Account ID" in the Cloudflare dashboard.
const CF_ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;

export const createAgentSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens only"),
    llmProvider: z.enum(["openrouter", "anthropic", "cloudflare"]),
    llmKey: z.string().min(20, "LLM key looks too short"),
    cfAccountId: z.string().optional(),
    personalityId: z.string().min(1).max(64).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.llmProvider === "cloudflare") {
      if (!CF_TOKEN_RE.test(body.llmKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["llmKey"],
          message: "expected a Cloudflare API token (letters, digits, _ or -)",
        });
      }
      // Account ID is optional — the API auto-detects it from the token. Only
      // validate the format when the user did supply one.
      if (body.cfAccountId && !CF_ACCOUNT_ID_RE.test(body.cfAccountId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cfAccountId"],
          message: "Cloudflare Account ID must be 32 hex characters",
        });
      }
      return;
    }

    const prefix = KEY_PREFIX[body.llmProvider];
    if (prefix && !body.llmKey.startsWith(prefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["llmKey"],
        message: `expected an ${
          body.llmProvider === "anthropic" ? "Anthropic (sk-ant-…)" : "OpenRouter (sk-or-…)"
        } key`,
      });
    }
  });

export type CreateAgentBody = z.infer<typeof createAgentSchema>;
