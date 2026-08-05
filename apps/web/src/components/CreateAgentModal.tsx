"use client";

import { useState } from "react";
import { BrandMark } from "./BrandMark";
import { DeployProgress } from "./DeployProgress";

type Provider = "openrouter" | "anthropic" | "cloudflare";

const KEY_PLACEHOLDER: Record<Provider, string> = {
  openrouter: "sk-or-...",
  anthropic: "sk-ant-...",
  cloudflare: "Cloudflare API token (Workers AI: Edit)",
};

const KEY_HELP: Record<Provider, string> = {
  openrouter: "Your OpenRouter key. Lives only in your agent's container.",
  anthropic: "Your Anthropic key. Lives only in your agent's container.",
  cloudflare:
    "An API token with the Workers AI permission. Lives only in your agent's container.",
};

function defaultAgentName(): string {
  return `hermes-${Math.floor(1000 + Math.random() * 9000)}`;
}

const INPUT =
  "mt-2 h-11 w-full border border-foreground bg-transparent px-3 font-mono text-sm text-foreground outline-none transition placeholder:text-muted focus:ring-1 focus:ring-foreground";

export function CreateAgentModal({
  onClose,
  onFinished,
}: {
  onClose: () => void;
  onFinished: () => void;
}) {
  const [name, setName] = useState(defaultAgentName);
  const [llmProvider, setLlmProvider] = useState<Provider>("openrouter");
  const [llmKey, setLlmKey] = useState("");
  const [cfAccountId, setCfAccountId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<{ id: string; wsToken: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          llmProvider,
          llmKey,
          ...(llmProvider === "cloudflare" && cfAccountId ? { cfAccountId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "something went wrong");
        return;
      }
      // Hand off to the live deploy view instead of a fixed loader.
      setDeploy({ id: data.id, wsToken: data.wsToken });
    } catch {
      setError("network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4 backdrop-blur-md"
      onClick={deploy ? undefined : onClose}
    >
      <div onClick={(e) => e.stopPropagation()}>
        {deploy ? (
          <DeployProgress
            agentId={deploy.id}
            wsToken={deploy.wsToken}
            onDone={() => {
              onFinished();
            }}
          />
        ) : (
          <form
            onSubmit={submit}
            className="rise w-[min(500px,94vw)] border-2 border-foreground bg-background p-6"
          >
            <div className="flex items-start justify-between gap-3 border-b border-panel-edge pb-5">
              <div>
                <BrandMark sublabel="Deploy Hermes" size="sm" />
                <p className="mt-3 text-sm text-muted">
                  Launch a private web chat and Telegram agent.
                </p>
              </div>
            </div>

            <label className="mt-5 block text-sm font-bold uppercase tracking-widest text-foreground">Agent name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="hermes-1001"
              className={INPUT}
            />
            <p className="mt-2 text-xs text-muted-2">
              Lowercase letters, numbers, and hyphens. A default is ready for fast deploys.
            </p>

            <label className="mt-5 block text-sm font-bold uppercase tracking-widest text-foreground">Provider</label>
            <select
              value={llmProvider}
              onChange={(e) => setLlmProvider(e.target.value as Provider)}
              className={INPUT}
            >
              <option value="openrouter">OpenRouter</option>
              <option value="anthropic">Anthropic</option>
              <option value="cloudflare">Cloudflare (Workers AI)</option>
            </select>

            {llmProvider === "cloudflare" && (
              <>
                <label className="mt-5 block text-sm font-bold uppercase tracking-widest text-foreground">
                  Cloudflare account ID <span className="text-muted-2">(optional)</span>
                </label>
                <input
                  value={cfAccountId}
                  onChange={(e) => setCfAccountId(e.target.value.trim())}
                  placeholder="Auto-detected from your token"
                  className={INPUT}
                />
                <p className="mt-2 text-xs text-muted-2">
                  Leave blank — we detect it from your token. Only needed if
                  detection fails (dashboard → your account → Account ID).
                </p>
              </>
            )}

            <label className="mt-5 block text-sm font-bold uppercase tracking-widest text-foreground">LLM API key</label>
            <input
              value={llmKey}
              onChange={(e) => setLlmKey(e.target.value)}
              placeholder={KEY_PLACEHOLDER[llmProvider]}
              type="password"
              className={INPUT}
            />
            <p className="mt-2 text-xs text-muted-2">{KEY_HELP[llmProvider]}</p>

            {error && (
              <p className="mt-4 rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
                {error}
              </p>
            )}

            <div className="mt-8 flex items-center justify-end gap-4 border-t border-panel-edge pt-6">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="h-10 border border-foreground px-6 font-mono text-xs font-bold uppercase tracking-widest text-foreground transition hover:bg-foreground hover:text-white disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="group inline-flex h-10 items-center gap-2 border border-foreground bg-foreground px-6 font-mono text-xs font-bold uppercase tracking-widest text-white transition hover:bg-transparent hover:text-foreground disabled:opacity-50"
              >
                {pending ? "Creating…" : "Deploy Hermes"}
                {!pending && <span className="transition-transform group-hover:translate-x-1">→</span>}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
