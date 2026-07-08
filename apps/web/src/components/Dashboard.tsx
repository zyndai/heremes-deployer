"use client";

import { useEffect, useRef, useState } from "react";
import { AgentCard } from "./AgentCard";
import { BrandMark } from "./BrandMark";
import { CreateAgentModal } from "./CreateAgentModal";
import { SignOutButton } from "./SignOutButton";
import type { AgentView } from "./types";

export function Dashboard({
  initialAgents,
  userName,
  maxAgents,
  notice,
}: {
  initialAgents: AgentView[];
  userName: string;
  maxAgents: number;
  notice?: { kind: "ok" | "error"; text: string } | null;
}) {
  const [agents, setAgents] = useState<AgentView[]>(initialAgents);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Dismissible one-shot banner for the Connect Zynd Persona round-trip result
  // (?zynd=connected / ?zynd_error=...). Seeded from the server prop.
  const [noticeShown, setNoticeShown] = useState(true);
  const atLimit = agents.length >= maxAgents;
  const runningCount = agents.filter((agent) => agent.status === "running").length;

  // Ref lets the stable polling interval read the latest list without being a
  // dependency, which would re-subscribe every render.
  const agentsRef = useRef(agents);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  // Poll live status while any agent exists, catching both provisioning→running
  // and later crashes; interval stays stable by reading the freshest list via ref.
  // GET /api/agents/[id] returns { agent: { id, name, slug, status, hostUrl, ... } };
  // merge the live status/hostUrl into the card's existing AgentView.
  useEffect(() => {
    let cancelled = false;
    const id = setInterval(async () => {
      const current = agentsRef.current;
      if (current.length === 0) return;
      const updated = await Promise.all(
        current.map(async (a) => {
          try {
            const res = await fetch(`/api/agents/${a.id}`);
            if (!res.ok) return a;
            const { agent } = (await res.json()) as {
              agent: { status: string; hostUrl: string | null };
            };
            return { ...a, status: agent.status, hostUrl: agent.hostUrl };
          } catch {
            return a;
          }
        }),
      );
      if (!cancelled) setAgents(updated);
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // The modal hands off to the live deploy view and signals completion with no
  // payload, so refresh the list from the API. GET /api/agents returns the
  // Prisma-shaped AgentView rows ({id, name, slug, status, hostUrl, ...}); map
  // straight through to the cards.
  async function refreshAgents() {
    const res = await fetch("/api/agents");
    if (!res.ok) return;
    const { agents: rows } = (await res.json()) as {
      agents: Array<{
        id: string;
        name: string;
        slug: string;
        status: string;
        hostUrl: string | null;
        personalityId?: string;
        personaLinked: boolean;
        createdAt: string;
      }>;
    };
    setAgents(
      rows.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        status: a.status,
        hostUrl: a.hostUrl,
        ...(a.personalityId ? { personalityId: a.personalityId } : {}),
        personaLinked: a.personaLinked,
        createdAt: a.createdAt,
      })),
    );
  }

  function onAgentUpdate(updated: AgentView) {
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }

  async function onDelete(id: string) {
    setDeleting(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/agents/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(data.error ?? "Could not clean up that agent.");
        return;
      }
      // Remove the card immediately — the worker drains the `deleting` row and
      // deletes it, so the next full refresh won't bring it back. (The per-agent
      // status poll only updates existing cards, never re-adds a filtered one.)
      setAgents((prev) => prev.filter((a) => a.id !== id));
    } finally {
      setDeleting(null);
    }
  }

  return (
    <main className="relative z-10 flex h-screen w-full flex-col overflow-hidden bg-background font-sans text-foreground selection:bg-foreground selection:text-white">

      {/* Top Nav */}
      <nav className="flex items-center justify-between border-b border-panel-edge shrink-0 w-full z-10 px-6 py-4">
        <BrandMark />
        
        <div className="flex items-center gap-6">
          {/* Metrics */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-green" />
              <span className="text-sm font-medium text-foreground">{runningCount} <span className="text-muted-2">Active</span></span>
            </div>
            <div className="w-px h-4 bg-panel-edge" />
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-foreground" />
              <span className="text-sm font-medium text-foreground">{agents.length}/{maxAgents} <span className="text-muted-2">Slots</span></span>
            </div>
          </div>

          <div className="hidden sm:block w-px h-6 bg-panel-edge" />

          {/* User Profile */}
          <div className="hidden sm:flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-xs font-bold text-white">
              {userName.slice(0, 1).toUpperCase()}
            </div>
            <span className="text-sm font-medium text-foreground">{userName}</span>
          </div>

          <div className="w-px h-6 bg-panel-edge" />

          <SignOutButton />
        </div>
      </nav>

      <div className="flex h-full w-full flex-col px-6 py-6 lg:px-8 relative z-10">
        {/* Main Content Area */}
        <div className="flex flex-1 flex-col overflow-hidden">

          {notice && noticeShown && (
            <div
              className={`mb-6 shrink-0 inline-flex items-center gap-3 rounded-full border px-4 py-2 text-sm font-medium ${
                notice.kind === "ok"
                  ? "bg-green/10 border-green/20 text-green"
                  : "bg-red/10 border-red/20 text-red"
              }`}
            >
              <span>{notice.text}</span>
              <button
                onClick={() => setNoticeShown(false)}
                className="text-xs uppercase tracking-widest opacity-70 hover:opacity-100"
              >
                Dismiss
              </button>
            </div>
          )}

          {actionError && (
            <div className="mb-6 shrink-0 inline-flex items-center gap-3 rounded-full bg-red/10 border border-red/20 px-4 py-2 text-sm text-red font-medium">
              {actionError}
            </div>
          )}

          {/* Agents List Area */}
          <div className="flex-1 flex flex-col min-h-0 pb-8">
            {agents.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center text-center border-2 border-panel-edge border-dashed bg-transparent p-12">
                <h3 className="font-display text-2xl uppercase tracking-wide text-foreground mb-2">No Deployments Found</h3>
                <p className="max-w-sm text-sm text-muted mb-8">
                  Connect your API keys to spin up a secure, containerized Hermes agent instantly.
                </p>
                <button
                  onClick={() => setModalOpen(true)}
                  className="inline-flex h-12 items-center justify-center px-8 border border-foreground bg-transparent text-sm font-mono font-bold text-foreground transition-all hover:bg-foreground hover:text-white"
                >
                  START FIRST DEPLOYMENT
                </button>
              </div>
            ) : (
              <div className="flex flex-col h-full gap-4">
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <h2 className="text-[10px] font-mono font-bold uppercase tracking-[0.2em] text-foreground">Your Fleet</h2>
                  {!atLimit && (
                    <button
                      onClick={() => setModalOpen(true)}
                      className="inline-flex h-9 items-center justify-center px-5 border border-foreground bg-transparent text-xs font-mono font-bold text-foreground transition-all hover:bg-foreground hover:text-white"
                    >
                      + DEPLOY NEW
                    </button>
                  )}
                </div>
                <div className="flex flex-col flex-1 min-h-0 mt-4">
                  {agents.map((a) => (
                    <AgentCard key={a.id} agent={a} onDelete={onDelete} onUpdate={onAgentUpdate} deleting={deleting === a.id} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {modalOpen && (
        <CreateAgentModal
          onClose={() => setModalOpen(false)}
          onFinished={() => {
            setModalOpen(false);
            void refreshAgents();
          }}
        />
      )}
    </main>
  );
}


