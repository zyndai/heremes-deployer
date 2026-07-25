"use client";

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

type Status = "connecting" | "connected" | "disconnected" | "error";

// Mirrors deployUrl in useDeploySocket.ts: prefer the worker's public WSS via
// NEXT_PUBLIC_WS_URL, else same-origin. A live shell has no polling fallback, so
// NEXT_PUBLIC_WS_URL MUST point at the Caddy-fronted worker for the terminal to
// connect from the Vercel-hosted dashboard.
function terminalUrl(agentId: string, token: string): string {
  const path = `/v1/agents/${agentId}/terminal?token=${encodeURIComponent(token)}`;
  const base = process.env.NEXT_PUBLIC_WS_URL;
  if (base) return `${base}${path}`;
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}${path}`;
}

const STATUS_LABEL: Record<Status, string> = {
  connecting: "connecting…",
  connected: "connected",
  disconnected: "disconnected",
  error: "connection failed",
};

export function AgentTerminal({ agentId }: { agentId: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("connecting");
  // Bumping `attempt` re-runs the effect to reconnect.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    let fit: import("@xterm/addon-fit").FitAddon | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const sendResize = (): void => {
      if (!term || !fit || !ws || ws.readyState !== WebSocket.OPEN) return;
      fit.fit();
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    async function connect(): Promise<void> {
      setStatus("connecting");

      let token: string;
      try {
        const res = await fetch(`/api/agents/${agentId}/terminal-token`);
        if (!res.ok) {
          if (!disposed) setStatus("error");
          return;
        }
        token = ((await res.json()) as { token: string }).token;
      } catch {
        if (!disposed) setStatus("error");
        return;
      }
      if (disposed) return;

      // Client-only import: xterm touches `window` at module load, which would
      // break SSR if imported at the top level.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !mountRef.current) return;

      term = new Terminal({
        cursorBlink: true,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 13,
        theme: { background: "#0b1020", foreground: "#d6e2ff" },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(mountRef.current);
      fit.fit();

      const encoder = new TextEncoder();

      ws = new WebSocket(terminalUrl(agentId, token));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (disposed) return;
        setStatus("connected");
        sendResize();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            if ((JSON.parse(ev.data) as { type?: string }).type === "exit") {
              term?.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
            }
          } catch {
            // non-JSON text — ignore
          }
          return;
        }
        term?.write(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onclose = () => {
        if (!disposed) setStatus("disconnected");
      };
      ws.onerror = () => {
        if (!disposed) setStatus("error");
      };

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
      });

      resizeObserver = new ResizeObserver(() => sendResize());
      resizeObserver.observe(mountRef.current);
    }

    void connect();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [agentId, attempt]);

  const canReconnect = status === "disconnected" || status === "error";

  return (
    <div className="mt-4 border border-panel-edge">
      <div className="flex items-center justify-between border-b border-panel-edge bg-[#0b1020] px-3 py-2">
        <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#8cc7ff]">
          Terminal
          <span className="ml-2 text-muted-2">· {STATUS_LABEL[status]}</span>
        </span>
        {canReconnect && (
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#8cc7ff] hover:underline"
          >
            Reconnect
          </button>
        )}
      </div>
      <div ref={mountRef} className="h-80 w-full bg-[#0b1020] p-2" />
      <p className="border-t border-panel-edge bg-[#0b1020] px-3 py-1.5 text-[10px] font-mono text-muted-2">
        You are inside this agent&apos;s container — the host is not accessible.
      </p>
    </div>
  );
}
