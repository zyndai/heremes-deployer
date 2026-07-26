"use client";

import { useState, useEffect } from "react";
import { StatusBadge } from "./StatusBadge";
import type { AgentView } from "./types";

type Action = "start" | "stop" | "restart";
type LogStream = "stdout" | "stderr" | "system" | string;
type LogLevel = "info" | "session" | "agent" | "worker" | "warn" | "error" | "infra";

interface LogEntry {
  lineNo: number;
  text: string;
  stream: LogStream;
  ts: string;
}

interface RenderLogEntry extends LogEntry {
  level: LogLevel;
  label: string;
  hidden: boolean;
}

// start/stop/restart only do anything when a deployer-worker is draining the
// shared queue (it owns Docker). On the Vercel-only topology there is no worker,
// so these would silently no-op — gate them behind an explicit flag and tell the
// user instead of showing dead buttons. Set NEXT_PUBLIC_WORKER_ENABLED=true once
// a worker is running against the same database.
const WORKER_ENABLED = process.env.NEXT_PUBLIC_WORKER_ENABLED === "true";

export function AgentCard({
  agent,
  onDelete,
  onUpdate,
  deleting,
}: {
  agent: AgentView;
  onDelete: (id: string) => void;
  onUpdate: (agent: AgentView) => void;
  deleting: boolean;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const running = agent.status === "running";
  const stopped = agent.status === "stopped";
  const unhealthy = agent.status === "unhealthy";

  async function control(action: Action) {
    setBusy(action);
    try {
      const res = await fetch(`/api/agents/${agent.id}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        const data = (await res.json()) as { agent: { id: string; status: string } };
        onUpdate({
          ...agent,
          status: data.agent.status,
          ...(data.agent.status === "stopped" ? { hostUrl: null } : {}),
        });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex w-full h-full flex-col gap-6 py-4">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-6 shrink-0">
        <div>
          <div className="flex items-center gap-4">
            <h3 className="font-display text-4xl tracking-tight text-foreground uppercase">
              {agent.name}
            </h3>
            <StatusBadge status={agent.status} />
          </div>
          <p className="mt-2 font-mono text-sm text-muted-2">ID: {agent.slug}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {WORKER_ENABLED && stopped && (
            <ActionButton label="Start" busyLabel="starting…" active={busy === "start"} disabled={!!busy} onClick={() => control("start")} primary />
          )}
          {WORKER_ENABLED && running && (
            <>
              <ActionButton label="Restart" busyLabel="restarting…" active={busy === "restart"} disabled={!!busy} onClick={() => control("restart")} />
              <ActionButton label="Stop" busyLabel="stopping…" active={busy === "stop"} disabled={!!busy} onClick={() => control("stop")} />
            </>
          )}
          
          <button
            onClick={() => onDelete(agent.id)}
            disabled={deleting || !!busy}
            title="Delete this agent"
            className="border border-red text-red px-4 py-2 font-mono text-xs uppercase tracking-widest transition hover:bg-red hover:text-white disabled:opacity-40"
          >
            {deleting ? "deleting…" : "Delete"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 shrink-0">
        {running && agent.hostUrl && (
          <div className="flex items-center gap-4 border border-foreground p-4">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-2 mb-1">Private Dashboard</p>
              <p className="block truncate font-mono text-sm text-muted">
                {agent.hostUrl.replace(/^https?:\/\//, "")}
              </p>
            </div>
            {/* Open via the owner-token exchange — the bare URL is gated, so a
                direct link would 401. /open mints a token and redirects. */}
            <a
              href={`/api/agents/${agent.id}/open`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 border border-foreground px-5 py-2 text-xs font-mono font-bold uppercase text-foreground transition hover:bg-foreground hover:text-white"
            >
              Open ↗
            </a>
          </div>
        )}

        {running && agent.hostUrl && (
          <div className="flex items-center gap-4 border border-foreground p-4">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-2 mb-1">Zynd Persona Memory</p>
              <p className="block truncate font-mono text-sm text-muted">
                {agent.personaLinked
                  ? "Connected — this agent ingests your messages and can recall your ZYND memory."
                  : "Give this agent your personal ZYND memory (ingest + recall)."}
              </p>
            </div>
            {/* Full-page navigation (not a new tab): the OAuth flow redirects to
                ZYND sign-in and back to /api/agents/<id>/zynd/callback, which must
                land in this same window to complete the link. Reconnect rotates
                the stored 90-day token. */}
            <a
              href={`/api/agents/${agent.id}/zynd/connect`}
              className={`shrink-0 border px-5 py-2 text-xs font-mono font-bold uppercase transition ${
                agent.personaLinked
                  ? "border-muted-2 text-muted-2 hover:bg-muted-2 hover:text-white"
                  : "border-foreground text-foreground hover:bg-foreground hover:text-white"
              }`}
            >
              {agent.personaLinked ? "Reconnect" : "Connect Zynd Persona"}
            </a>
          </div>
        )}

        {stopped && (
          <div className="border border-foreground p-4">
            <p className="text-sm font-mono text-muted">
              {WORKER_ENABLED ? "Agent is stopped. Start it again to access the dashboard." : "Agent is stopped."}
            </p>
          </div>
        )}

        {unhealthy && (
          <div className="border border-red p-4">
            <p className="text-sm font-mono text-red">
              Agent health check failed or the container crashed. Please check the logs for details.
            </p>
          </div>
        )}

        {!WORKER_ENABLED && (running || stopped || unhealthy) && (
          <div className="border border-amber p-4">
            <p className="text-sm font-mono text-amber">
              Lifecycle controls need a running deployer-worker. Provisioning is unavailable here.
            </p>
          </div>
        )}
      </div>

      {(running || stopped || unhealthy) && (
        <TerminalLogs agentId={agent.id} />
      )}
    </div>
  );
}

function TerminalLogs({ agentId }: { agentId: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [message, setMessage] = useState<string>("loading...");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/agents/${agentId}/logs`);
        const data = (await res.json()) as {
          entries?: LogEntry[];
          logs?: string;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setState("error");
          setMessage(data.error || "could not read logs");
          return;
        }
        const entries = Array.isArray(data.entries)
          ? data.entries
          : (data.logs ?? "")
              .split("\n")
              .filter(Boolean)
              .map((text, index) => ({
                lineNo: index + 1,
                text,
                stream: "stdout",
                ts: new Date().toISOString(),
              }));
        setLogs(entries);
        setState(entries.length > 0 ? "ready" : "empty");
        setMessage(entries.length > 0 ? "" : "(no agent activity yet)");
      } catch {
        if (!cancelled) {
          setState("error");
          setMessage("(network error reading logs)");
        }
      }
    }
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agentId]);

  const enriched = logs.map(classifyLogEntry);
  const visible = enriched.filter((entry) => !entry.hidden);
  const hiddenCount = enriched.length - visible.length;
  const lines = visible;
  const terminalMessage =
    state === "ready" && logs.length > 0 && lines.length === 0 ? "Waiting for Hermes activity..." : message;

  return (
    <div className="mt-2 flex-1 overflow-hidden relative min-h-0 border border-foreground bg-[#06151f] text-[#d9f7ff] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
      <div className="absolute inset-x-0 top-0 z-10 flex h-11 items-center justify-between border-b border-white/10 bg-[#081823]/95 px-4">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-red" />
          <div className="h-2 w-2 rounded-full bg-amber" />
          <div className="h-2 w-2 rounded-full bg-green" />
          <span className="ml-2 text-[10px] font-mono font-bold tracking-widest uppercase text-[#8cc7ff]">Agent Activity</span>
        </div>
        {hiddenCount > 0 && (
          <span className="text-[10px] font-mono uppercase tracking-widest text-[#6e8795]">
            {hiddenCount} infra hidden
          </span>
        )}
      </div>
      <pre className="absolute inset-0 overflow-auto whitespace-pre-wrap px-4 pb-4 pt-14 font-mono text-[11px] leading-relaxed scrollbar-hide">
        {state === "ready" && lines.length > 0 ? (
          lines.map((entry) => (
            <span key={`${entry.lineNo}-${entry.ts}`} className={`block ${logTextClass(entry.level)}`}>
              <span className="mr-3 select-none text-[#426273]">{formatLogTime(entry.ts)}</span>
              <span className={`mr-3 select-none ${logLabelClass(entry.level)}`}>{entry.label.padEnd(7)}</span>
              <span>{entry.text}</span>
            </span>
          ))
        ) : (
          <span className={state === "error" ? "text-red" : "text-[#8cc7ff]"}>{terminalMessage}</span>
        )}
      </pre>
    </div>
  );
}

function classifyLogEntry(entry: LogEntry): RenderLogEntry {
  const text = entry.text.trim();
  const lower = text.toLowerCase();
  const isError =
    entry.stream === "stderr" ||
    /\b(error|failed|failure|crash|exception|traceback|denied|unhealthy|timeout|oom)\b/i.test(text);
  const isWarn = !isError && /\b(warn|warning|retry|degraded|disconnect|reconnect|forbidden|403|429)\b/i.test(text);
  const isSession = /\b(session|chat|message|telegram|pairing|onboarding|connect|linked|conversation|websocket|socket)\b/i.test(text);
  const isAgent = /\b(hermes|gateway|dashboard|agent|model|provider|live at|messaging platforms|cron scheduler)\b/i.test(text);
  const isWorker = /^\[(worker|crash|failed)\]/i.test(text) || /\b(health|route|started container|seeded config)\b/i.test(text);
  const isInfra =
    /^(cont-init:|s6-rc:|reconcile:|supervise-|finish:|\[stage2\]|user\/)/.test(lower) ||
    lower.includes("s6 supervision") ||
    lower.includes("container image") ||
    lower.includes("pre-s6 foreground") ||
    lower.includes("ctrl+c to stop") ||
    /^[\s|+`-]+$/.test(text);

  if (isError) return { ...entry, level: "error", label: "ERROR", hidden: false };
  if (isWarn) return { ...entry, level: "warn", label: "WARN", hidden: false };
  if (isInfra) return { ...entry, level: "infra", label: "INFRA", hidden: true };
  if (isSession) return { ...entry, level: "session", label: "SESSION", hidden: false };
  if (isAgent) return { ...entry, level: "agent", label: "AGENT", hidden: false };
  if (isWorker) return { ...entry, level: "worker", label: "WORKER", hidden: false };
  if (entry.stream === "system") return { ...entry, level: "worker", label: "WORKER", hidden: false };
  return { ...entry, level: "info", label: "INFO", hidden: false };
}

function logTextClass(level: LogLevel): string {
  switch (level) {
    case "error":
      return "text-[#ff8f9b]";
    case "warn":
      return "text-[#ffd17a]";
    case "session":
      return "text-[#77f0d2]";
    case "agent":
      return "text-[#a7d8ff]";
    case "worker":
      return "text-[#b7a6ff]";
    case "infra":
      return "text-[#6e8795]";
    default:
      return "text-[#d9f7ff]";
  }
}

function logLabelClass(level: LogLevel): string {
  switch (level) {
    case "error":
      return "text-red";
    case "warn":
      return "text-amber";
    case "session":
      return "text-green";
    case "agent":
      return "text-[#55b9ff]";
    case "worker":
      return "text-[#aa96ff]";
    case "infra":
      return "text-[#6e8795]";
    default:
      return "text-[#8cc7ff]";
  }
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ActionButton({
  label,
  busyLabel,
  active,
  disabled,
  onClick,
  primary = false,
}: {
  label: string;
  busyLabel: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  const cls = primary
    ? "border border-foreground bg-foreground px-4 py-2 text-xs font-mono font-bold uppercase tracking-widest text-white transition hover:bg-transparent hover:text-foreground disabled:opacity-40"
    : "border border-foreground bg-transparent px-4 py-2 text-xs font-mono font-bold uppercase tracking-widest text-foreground transition hover:bg-foreground hover:text-white disabled:opacity-40";
  return (
    <button onClick={onClick} disabled={disabled} className={cls}>
      {active ? busyLabel : label}
    </button>
  );
}
