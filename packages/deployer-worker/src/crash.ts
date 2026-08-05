// docker events watcher. One long-lived connection; for every `die`/`oom`
// event on a `hermes-<id>` container we capture the exit code + log tail
// and mark the agent crashed.
//
// Verbatim port of deployer/worker/crash.ts (zynd-deployer). Only deltas:
// label zynd.deployment -> hermes.agent, table Deployment -> Agent, key
// deploymentId -> agentId. die/oom filter and idempotency guard unchanged.

import {
  docker,
  inspectExitCode,
  inspectTerminalState,
  stopAndRemove,
  tailLogs,
} from "./docker";
import { prisma } from "./db";
import { config } from "./config";
import { appendSystemLog, stopTailer } from "./logs";
import { releasePort } from "./ports";

export async function watchCrashes(): Promise<void> {
  console.log("[crash watcher] attaching to docker events");
  const stream = await docker.getEvents({ filters: { type: ["container"] } });

  let buf = "";
  stream.on("data", async (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as {
          Action?: string;
          status?: string;
          Actor?: { ID?: string; Attributes?: Record<string, string> };
        };
        const action = ev.Action ?? ev.status;
        if (!action) continue;

        // Only `die` is the definitive terminal signal with a stable exit
        // code. Acting on `kill` would loop: stopAndRemove -> SIGTERM ->
        // `kill` -> handle -> stopAndRemove -> … `oom` is an explicit OOM
        // notification but the real transition still happens on `die`.
        if (action !== "die" && action !== "oom") continue;

        const labels = ev.Actor?.Attributes ?? {};
        const agentId = labels["hermes.agent"];
        if (!agentId) continue;

        const containerId = ev.Actor?.ID;
        if (!containerId) continue;

        console.log(
          `[crash watcher] event action=${action} agent=${agentId} ` +
            `container=${containerId.slice(0, 12)}`
        );

        const state = await inspectTerminalState(containerId);
        const exitCode =
          Number(labels["exitCode"]) ||
          state?.exitCode ||
          (await inspectExitCode(containerId)) ||
          null;
        const oomKilled = state?.oomKilled ?? false;
        const dockerErr = state?.error ?? "";

        const current = await prisma.agent.findUnique({
          where: { id: agentId },
          select: { status: true },
        });
        if (!current) {
          console.log(`[crash watcher] agent ${agentId} not found, skipping`);
          continue;
        }

        // Idempotency: skip if already terminal or in the deploy pipeline.
        // During a restart/redeploy, the old container is torn down while the
        // agent is queued/starting — the crash watcher must not mark these as
        // crashed because a new container is about to replace the old one.
        const SKIP_STATUSES = new Set([
          "stopped",
          "crashed",
          "failed",
          "queued",
          "allocating_ports",
          "starting",
          "health_checking",
          "registering_route",
          "updating",
          "deleting",
        ]);
        if (SKIP_STATUSES.has(current.status)) {
          console.log(
            `[crash watcher] agent ${agentId} status=${current.status}, ignoring ${action}`
          );
          continue;
        }

        const tail = (await tailLogs(containerId, 200)).trim();
        const reason = oomKilled
          ? `Container OOM-killed (memory limit ${state?.memoryLimitMb ?? "?"}MB)`
          : exitCode !== null
            ? `Container exited ${exitCode}`
            : "Container died unexpectedly";

        await prisma.agent.update({
          where: { id: agentId },
          data: {
            status: "crashed",
            lastExitCode: exitCode,
            lastCrashAt: new Date(),
            errorMessage: reason,
          },
        });

        const header = oomKilled
          ? `[CRASH exit=${exitCode ?? "?"} OOMKilled=true memLimit=${state?.memoryLimitMb ?? "?"}MB]`
          : `[CRASH exit=${exitCode ?? "?"}]`;
        const stateSummary = state
          ? `\n[state] oomKilled=${state.oomKilled} memLimit=${state.memoryLimitMb ?? "?"}MB ` +
            `dockerErr=${state.error || "(none)"} ` +
            `startedAt=${state.startedAt} finishedAt=${state.finishedAt}`
          : "";
        await appendSystemLog(agentId, `${header}${stateSummary}\n${tail.slice(-2000)}`);
        stopTailer(agentId);

        // Free the port regardless — otherwise a follow-up deploy for the
        // same slug can't reuse it.
        await releasePort(agentId).catch(() => undefined);

        if (config.keepCrashedContainers) {
          console.log(
            `[crash watcher] keeping container ${containerId.slice(0, 12)} for post-mortem`
          );
        } else {
          await stopAndRemove(containerId).catch((err) => {
            console.error(`[crash watcher] sweep ${containerId} failed:`, err);
          });
        }

        void dockerErr;
      } catch (e) {
        console.warn("[crash watcher] malformed event:", (e as Error).message);
      }
    }
  });

  stream.on("error", (e) => {
    console.error("[crash watcher]", e);
  });
}
