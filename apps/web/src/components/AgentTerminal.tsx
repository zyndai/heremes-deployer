"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Close codes shell.ts (deployer-worker) uses — kept in sync manually, same
// as GATE_OPEN_PATH's duplicated-constant precedent elsewhere in this app.
const CLOSE_REASON: Record<number, string> = {
  4401: "Session expired — switch tabs and back to reconnect.",
  4403: "You don't own this agent.",
  4404: "Agent not found.",
  4409: "Agent isn't running.",
};

// Scoped to exactly one agent's own container (dockerode exec, uid 10000, cwd
// /opt/data — see shell.ts). There is no path from here to the EC2 host or to
// any other agent's container. Mounted only while its tab is active (parent
// conditional-renders this) — switching away tears the WS + exec down rather
// than leaving a shell session running unattended in the background.
export function AgentTerminal({ agentId }: { agentId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let term: Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function connect() {
      const res = await fetch(`/api/agents/${agentId}/shell-token`);
      const data = (await res.json()) as { wsUrl?: string; error?: string };
      if (cancelled) return;
      if (!res.ok || !data.wsUrl) {
        setError(data.error ?? "could not open terminal");
        return;
      }

      const el = containerRef.current;
      if (!el) return;

      term = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--font-mono), ui-monospace, monospace",
        fontSize: 12,
        theme: { background: "#06151f", foreground: "#d9f7ff" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      // Without this, the terminal never receives keystrokes until the user
      // clicks inside it a SECOND time: it's reached by clicking the
      // "Terminal" tab button, which keeps DOM focus on that button — xterm
      // only wires keyboard capture to its own hidden textarea, and nothing
      // moves focus there automatically on mount. Confirmed via a Playwright
      // repro: without this call, document.activeElement stays the tab
      // button and zero keystrokes reach term.onData; with it, focus lands
      // on xterm's textarea and typing works immediately.
      term.focus();

      const socket = new WebSocket(data.wsUrl);
      socket.binaryType = "arraybuffer";
      ws = socket;

      function sendResize() {
        if (!term || !fit || socket.readyState !== WebSocket.OPEN) return;
        fit.fit();
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }

      socket.onopen = () => sendResize();
      socket.onmessage = (ev) => {
        const chunk =
          ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : String(ev.data);
        term?.write(chunk as never);
      };
      socket.onclose = (ev) => {
        term?.write(`\r\n\r\n[${CLOSE_REASON[ev.code] ?? `connection closed (${ev.code})`}]\r\n`);
      };
      socket.onerror = () => {
        term?.write("\r\n\r\n[connection error]\r\n");
      };

      term.onData((chunk) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "data", data: chunk }));
        }
      });

      resizeObserver = new ResizeObserver(() => sendResize());
      resizeObserver.observe(el);
    }

    connect().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : "could not open terminal");
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      ws?.close();
      term?.dispose();
    };
  }, [agentId]);

  return (
    <div className="mt-2 flex-1 overflow-hidden relative min-h-0 border border-foreground bg-[#06151f] text-[#d9f7ff] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]">
      <div className="absolute inset-x-0 top-0 z-10 flex h-11 items-center justify-between border-b border-white/10 bg-[#081823]/95 px-4">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-red" />
          <div className="h-2 w-2 rounded-full bg-amber" />
          <div className="h-2 w-2 rounded-full bg-green" />
          <span className="ml-2 text-[10px] font-mono font-bold tracking-widest uppercase text-[#8cc7ff]">
            Terminal — this container only
          </span>
        </div>
      </div>
      {error ? (
        <p className="absolute inset-0 px-4 pb-4 pt-14 font-mono text-sm text-red">{error}</p>
      ) : (
        <div ref={containerRef} className="absolute inset-0 pt-11 px-2 pb-2" />
      )}
    </div>
  );
}
