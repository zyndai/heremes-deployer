"use client";

import { useState, useEffect, useCallback } from "react";
import type { AgentView } from "./types";

interface VersionInfo {
  current: string | null;
  latest: string | null;
  releaseDate: string | null;
  changelogUrl: string | null;
  updateAvailable: boolean;
}

export function VersionPanel({ agent }: { agent: AgentView }) {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateSteps, setUpdateSteps] = useState<Record<string, string>>({});
  const [updateStatus, setUpdateStatus] = useState<string>("");
  const [updateError, setUpdateError] = useState<string | null>(null);

  const fetchVersion = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${agent.id}/version`);
      if (res.ok) {
        const data = (await res.json()) as VersionInfo;
        setVersionInfo(data);
      }
    } catch {
      // Silently ignore — version check is non-critical.
    }
  }, [agent.id]);

  useEffect(() => {
    if (agent.status === "running") {
      void fetchVersion();
    }
  }, [agent.status, fetchVersion]);

  // When the agent status flips to "updating", start streaming progress.
  useEffect(() => {
    if (agent.status !== "updating") return;
    setUpdating(true);
    setUpdateError(null);

    // Connect via polling since we can't open a WS from here without a token.
    // The update API mints the token, but we're reacting to status change
    // from the parent polling loop. We'll use a poll-based approach.
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/agents/${agent.id}`);
        if (!res.ok) return;
        const { agent: a } = (await res.json()) as {
          agent: { status: string; hermesVersion?: string | null; errorMessage?: string | null };
        };

        if (a.status === "running") {
          // Update complete — fetch version info and stop.
          setUpdateStatus("completed");
          setUpdateSteps((prev) => ({ ...prev, updating_complete: "ok" }));
          await fetchVersion();
          setUpdating(false);
          clearInterval(poll);
        } else if (a.status === "failed") {
          setUpdateError(a.errorMessage ?? "Update failed. Please try again.");
          setUpdating(false);
          clearInterval(poll);
        } else if (a.status === "updating") {
          // Still in progress — track the step from the status alone isn't granular,
          // so we just show a generic "Updating..." with steps based on timing.
          setUpdateStatus("in_progress");
        }
      } catch {
        // Retry next poll.
      }
    }, 2000);

    return () => clearInterval(poll);
  }, [agent.status, agent.id, fetchVersion]);

  async function handleUpdate(targetVersion: string) {
    setLoading(true);
    setShowModal(false);
    try {
      const res = await fetch(`/api/agents/${agent.id}/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetVersion }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setUpdateError(data.error ?? "Update request failed");
        return;
      }
      // Status will flip to "updating" — parent polling will pick it up.
      // Start a local progress tracker.
      setUpdating(true);
      setUpdateError(null);

      // Simulate progress steps based on timing since we don't have WS.
      startPollingUpdate(agent.id, fetchVersion);
    } catch {
      setUpdateError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function startPollingUpdate(agentId: string, onComplete: () => void) {
    const startedAt = Date.now();
    const steps = [
      { key: "pulling_image", at: 0 },
      { key: "creating_backup", at: 3000 },
      { key: "stopping_container", at: 5000 },
      { key: "starting_updated", at: 8000 },
      { key: "health_checking", at: 15000 },
    ];

    let done = false;
    const poll = setInterval(async () => {
      if (done) return;
      try {
        const res = await fetch(`/api/agents/${agentId}`);
        if (!res.ok) return;
        const { agent: a } = (await res.json()) as {
          agent: { status: string; hermesVersion?: string | null; errorMessage?: string | null };
        };

        if (a.status === "running") {
          done = true;
          clearTimeout(safetyTimer);
          setUpdateSteps((prev) => {
            const next: Record<string, string> = { ...prev, updating_complete: "ok" };
            for (const s of steps) next[s.key] = "ok";
            return next;
          });
          setUpdateStatus("completed");
          onComplete();
          setUpdating(false);
          clearInterval(poll);
          return;
        }
        if (a.status === "failed") {
          done = true;
          clearTimeout(safetyTimer);
          setUpdateError(a.errorMessage ?? "Update failed");
          setUpdating(false);
          clearInterval(poll);
          return;
        }

        // Advance steps based on elapsed time
        const elapsed = Date.now() - startedAt;
        const newSteps: Record<string, string> = {};
        for (const s of steps) {
          if (elapsed >= s.at) newSteps[s.key] = "ok";
        }
        setUpdateSteps((prev) => ({ ...prev, ...newSteps }));
      } catch {
        // Retry.
      }
    }, 1000);

    // Safety: stop polling after 2 minutes
    const safetyTimer = setTimeout(() => {
      if (done) return;
      done = true;
      clearInterval(poll);
      setUpdating(false);
      setUpdateError("Update timed out. Check agent logs for details.");
    }, 120_000);
  }

  // Don't render anything for non-running, non-updating agents.
  if (agent.status !== "running" && agent.status !== "updating") return null;
  if (agent.status !== "updating" && !versionInfo) return null;

  // --- Updating in progress ---
  if (updating) {
    return (
      <div className="border border-foreground p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-2">
            Updating Hermes
            {updateStatus === "completed" ? " — Complete ✓" : "…"}
          </h3>
          {updateStatus !== "completed" && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-foreground opacity-70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-foreground" />
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div className="h-1 w-full overflow-hidden bg-foreground/20 mb-3">
          <div
            className="h-full bg-foreground transition-all duration-500"
            style={{
              width: `${
                updateStatus === "completed"
                  ? 100
                  : Object.keys(updateSteps).filter((k) => updateSteps[k] === "ok").length * 16
              }%`,
            }}
          />
        </div>

        <ul className="space-y-1.5">
          {[
            { key: "pulling_image", label: "Downloading image" },
            { key: "creating_backup", label: "Creating backup" },
            { key: "stopping_container", label: "Stopping container" },
            { key: "starting_updated", label: "Starting Hermes" },
            { key: "health_checking", label: "Running health checks" },
          ].map(({ key, label }) => (
            <li key={key} className="flex items-center gap-2">
              <span className="grid h-5 w-5 shrink-0 place-items-center text-[10px]">
                {updateSteps[key] === "ok" ? (
                  <span className="text-green text-xs">✓</span>
                ) : (
                  <span className="text-muted-2 text-xs">○</span>
                )}
              </span>
              <span
                className={`text-xs font-mono ${
                  updateSteps[key] === "ok" ? "text-foreground" : "text-muted-2"
                }`}
              >
                {label}
              </span>
            </li>
          ))}
        </ul>

        {updateStatus === "completed" && (
          <p className="mt-3 text-xs font-mono text-green">
            ✓ Update completed. Your data, MCPs, automations, and cron jobs are preserved.
          </p>
        )}
        {updateError && (
          <p className="mt-3 text-xs font-mono text-red">{updateError}</p>
        )}
      </div>
    );
  }

  // --- Version display ---
  return (
    <>
      <div className="border border-foreground p-4">
        <h3 className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-2 mb-3">
          Hermes Version
        </h3>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-muted-2 mb-0.5">Current</p>
            <p className="text-sm font-mono font-bold text-foreground">
              {versionInfo?.current ?? "Unknown"}
            </p>
          </div>
          {versionInfo?.latest && (
            <div>
              <p className="text-xs font-mono uppercase tracking-widest text-muted-2 mb-0.5">Latest</p>
              <p className="text-sm font-mono font-bold text-foreground">
                {versionInfo.latest}
              </p>
              {versionInfo.releaseDate && (
                <p className="text-[10px] font-mono text-muted mt-0.5">
                  Released {formatRelativeDate(versionInfo.releaseDate)}
                </p>
              )}
            </div>
          )}
        </div>

        {versionInfo?.updateAvailable ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-amber">
              ✓ New update available
            </span>
            {versionInfo.changelogUrl && (
              <a
                href={versionInfo.changelogUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] font-mono uppercase tracking-widest text-muted-2 hover:text-foreground underline underline-offset-2"
              >
                View Changelog
              </a>
            )}
            <button
              onClick={() => setShowModal(true)}
              className="ml-auto border border-foreground bg-transparent px-3 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest text-foreground transition hover:bg-foreground hover:text-white"
            >
              Update Hermes
            </button>
          </div>
        ) : (
          <p className="mt-3 text-[10px] font-mono uppercase tracking-widest text-green">
            ✓ You&apos;re running the latest version.
          </p>
        )}
      </div>

      {showModal && versionInfo?.latest && (
        <UpdateModal
          currentVersion={versionInfo.current ?? "Unknown"}
          newVersion={versionInfo.latest}
          onCancel={() => setShowModal(false)}
          onConfirm={() => handleUpdate(versionInfo.latest!)}
          loading={loading}
        />
      )}
    </>
  );
}

function UpdateModal({
  currentVersion,
  newVersion,
  onCancel,
  onConfirm,
  loading,
}: {
  currentVersion: string;
  newVersion: string;
  onCancel: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative z-10 w-[min(420px,94vw)] rise border-2 border-foreground bg-background p-6">
        <h2 className="font-display text-2xl uppercase tracking-wide text-foreground mb-1">
          Update Hermes
        </h2>
        <div className="mt-4 space-y-3">
          <div className="flex justify-between border border-panel-edge p-3">
            <span className="text-xs font-mono text-muted-2">Current Version</span>
            <span className="text-xs font-mono font-bold text-foreground">{currentVersion}</span>
          </div>
          <div className="flex justify-between border border-foreground p-3">
            <span className="text-xs font-mono text-muted-2">New Version</span>
            <span className="text-xs font-mono font-bold text-foreground">{newVersion}</span>
          </div>
        </div>
        <p className="mt-4 text-xs font-mono text-muted-2">This will:</p>
        <ul className="mt-2 space-y-1.5">
          {[
            "Backup your Hermes data",
            "Upgrade Hermes",
            "Preserve models",
            "Preserve API keys",
            "Preserve plugins",
            "Restart your agent",
          ].map((item) => (
            <li key={item} className="flex items-center gap-2 text-xs font-mono text-foreground">
              <span className="text-green text-xs">✓</span> {item}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[10px] font-mono uppercase tracking-widest text-muted-2">
          Downtime: Approximately 5-10 seconds
        </p>
        <div className="mt-5 flex gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 h-10 border border-panel-edge bg-transparent font-mono text-xs font-bold uppercase tracking-widest text-muted-2 transition hover:text-foreground disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 h-10 border border-foreground bg-foreground font-mono text-xs font-bold uppercase tracking-widest text-white transition hover:bg-transparent hover:text-foreground disabled:opacity-40"
          >
            {loading ? "Updating…" : "Update"}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatRelativeDate(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 1) return "today";
  if (diffDays === 1) return "1 day ago";
  if (diffDays < 30) return `${diffDays} days ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths === 1) return "1 month ago";
  if (diffMonths < 12) return `${diffMonths} months ago`;
  return "over a year ago";
}
