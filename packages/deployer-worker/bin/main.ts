// Worker entry point. Long-lived process (systemd unit:
// hermes-deployer-worker.service). Port of deployer/worker/main.ts
// (zynd-deployer). Each 1s tick:
//   1. drainQueue — claim the oldest `queued` agent (the updateMany to
//      `allocating_ports` IS the pessimistic lock) and drive it.
//   2. drainUpdates — sweep agents the API flipped to `updating`: pull new
//      image, stop old container, start new with same volume/ports, health
//      check, mark running with updated version.
//   3. drainStops — sweep agents the API flipped to `stopped`: tear down
//      container + Caddy route + ports, then clear the columns.
//   4. drainDeletes — sweep agents the API flipped to `deleting` ("Clean up"):
//      same teardown, then delete the row so the card leaves the list.
// The crash watcher, health/metrics/retention loops, and the deploy WS
// server are started once at boot.

import { prisma } from "../src/db";
import { drive, drainUpdates } from "../src/lifecycle";
import { watchCrashes } from "../src/crash";
import { stopAndRemove } from "../src/docker";
import { ensureServer, addRoute, removeRoute } from "../src/caddy";
import { releasePort } from "../src/ports";
import { appendSystemLog, stopTailer, startTailer } from "../src/logs";
import { startRetentionLoop } from "../src/retention";
import { startMetricsLoop } from "../src/metrics";
import { startHealthLoop } from "../src/health";
import { startWsServer } from "../src/ws";

const TICK_MS = 1000;

export async function drainQueue(): Promise<void> {
  // Claim the oldest queued row. The status=allocating_ports update is a
  // pessimistic lock — if another worker beat us, count is 0 and we loop.
  const candidate = await prisma.agent.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!candidate) return;

  const claimed = await prisma.agent.updateMany({
    where: { id: candidate.id, status: "queued" },
    data: { status: "allocating_ports" },
  });
  if (claimed.count === 0) {
    console.log(`[worker] lost race to claim ${candidate.id}, retrying`);
    return;
  }

  console.log(`[worker] claimed agent=${candidate.id}, driving`);
  const t0 = Date.now();
  // Foreground / serial per worker (one VPS for v1).
  try {
    await drive(candidate.id);
    console.log(`[worker] drive(${candidate.id}) finished in ${Date.now() - t0}ms`);
  } catch (e) {
    console.error(`[worker] drive(${candidate.id}) threw after ${Date.now() - t0}ms:`, e);
  }
}

export async function drainStops(): Promise<void> {
  const stopped = await prisma.agent.findMany({
    where: { status: "stopped", containerId: { not: null } },
    select: { id: true, containerId: true },
  });
  if (stopped.length > 0) {
    console.log(`[worker] draining ${stopped.length} stopped agent(s)`);
  }

  for (const row of stopped) {
    stopTailer(row.id);

    // Run each external step independently so one failure doesn't trap the
    // row in drainStops forever.
    const errors: string[] = [];
    if (row.containerId) {
      try {
        await stopAndRemove(row.containerId);
      } catch (e) {
        errors.push(`stopAndRemove: ${(e as Error).message}`);
      }
    }
    try {
      await removeRoute(row.id);
    } catch (e) {
      errors.push(`removeRoute: ${(e as Error).message}`);
    }
    try {
      await releasePort(row.id);
    } catch (e) {
      errors.push(`releasePort: ${(e as Error).message}`);
    }

    // Always clear container/port columns so the query stops selecting this
    // row. A genuinely leaked container/route surfaces once for the operator
    // — better than a wedged worker re-emitting the same error every second.
    try {
      await prisma.agent.update({
        where: { id: row.id },
        data: { containerId: null, apiPort: null, dashboardPort: null },
      });
    } catch (e) {
      console.error(`[worker] could not clear columns for ${row.id} — retry next tick:`, e);
      continue;
    }

    if (errors.length === 0) {
      await appendSystemLog(row.id, "[worker] cleaned up on stop").catch(() => undefined);
    } else {
      console.error(
        `[worker] stop cleanup ${row.id} had ${errors.length} error(s), row cleared anyway: ${errors.join("; ")}`
      );
      await appendSystemLog(
        row.id,
        `[worker] cleaned up with errors: ${errors.join("; ")}`
      ).catch(() => undefined);
    }
  }
}

// Sweep agents the API flipped to `deleting` (the "Clean up" action): tear down
// the container + Caddy route + ports, then DELETE the row so the card leaves
// the list. Mirrors drainStops' best-effort teardown, but removes the row
// instead of clearing columns. AgentLog cascades (schema onDelete: Cascade);
// releasePort already deletes the PortAllocation rows. An agent with no
// containerId (never started, or already stopped) deletes immediately.
export async function drainDeletes(): Promise<void> {
  const deleting = await prisma.agent.findMany({
    where: { status: "deleting" },
    select: { id: true, containerId: true, dashboardPort: true },
  });
  if (deleting.length > 0) {
    console.log(`[worker] draining ${deleting.length} agent(s) marked for deletion`);
  }

  for (const row of deleting) {
    stopTailer(row.id);

    // Best-effort teardown — a leaked container/route is logged but must not
    // wedge the delete, or the row would re-surface every tick.
    if (row.containerId) {
      await stopAndRemove(row.containerId).catch((e) =>
        console.error(`[worker] delete: stopAndRemove ${row.id}: ${(e as Error).message}`),
      );
    }
    await removeRoute(row.id).catch((e) =>
      console.error(`[worker] delete: removeRoute ${row.id}: ${(e as Error).message}`),
    );
    await releasePort(row.id).catch((e) =>
      console.error(`[worker] delete: releasePort ${row.id}: ${(e as Error).message}`),
    );

    try {
      await prisma.agent.delete({ where: { id: row.id } });
    } catch (e) {
      console.error(`[worker] could not delete row ${row.id} — retry next tick:`, e);
    }
  }
}

export async function resumeTailers(): Promise<void> {
  // After a restart, re-attach log tailers to still-running agents so the
  // live-log view keeps working.
  const running = await prisma.agent.findMany({
    where: { status: "running", containerId: { not: null } },
    select: { id: true, containerId: true },
  });
  for (const r of running) {
    if (r.containerId) {
      startTailer(r.id, r.containerId).catch((e) =>
        console.warn(`[worker] resume tailer ${r.id}:`, e)
      );
    }
  }
}

export async function reconcileRoutes(): Promise<void> {
  // After a host reboot, Caddy reloads the static Caddyfile and drops every
  // per-agent route the worker injected via the admin API (those routes live
  // only in Caddy's runtime config, never in the Caddyfile). Without this,
  // running agents silently TLS-fail / 404 until their next redeploy. Re-add a
  // route for each running agent at startup. Idempotent: addRoute dedupes by @id.
  const running = await prisma.agent.findMany({
    where: { status: "running", containerId: { not: null }, dashboardPort: { not: null } },
    select: { id: true, slug: true, dashboardPort: true },
  });
  let n = 0;
  for (const r of running) {
    if (r.dashboardPort == null) continue;
    try {
      await addRoute(r.id, r.slug, r.dashboardPort);
      n++;
    } catch (e) {
      console.error(`[worker] reconcile route ${r.slug}:`, e);
    }
  }
  console.log(`[worker] reconciled ${n} agent route(s) at startup`);
}

export async function main(): Promise<void> {
  console.log("[worker] starting");
  // Bootstrap Caddy once so the first addRoute doesn't 500 on "final
  // element is not an array". Non-fatal: keep the worker alive so each
  // deploy surfaces a clean FAILED instead of crashing the process.
  await ensureServer().catch((e) => console.error("[worker] ensureServer failed at startup:", e));
  await reconcileRoutes().catch((e) => console.error("[worker] reconcileRoutes failed at startup:", e));
  await resumeTailers();
  watchCrashes().catch((e) => console.error("[worker] crash watcher died:", e));
  startRetentionLoop();
  startMetricsLoop();
  startHealthLoop();
  startWsServer().catch((e) => console.error("[worker] ws server failed to start:", e));

  const shutdown = () => {
    console.log("[worker] shutting down");
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await drainQueue();
      await drainUpdates();
      await drainStops();
      await drainDeletes();
    } catch (e) {
      console.error("[worker] tick failed:", e);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

// Only enter the infinite loop when run as a script, not when imported by a
// test. import.meta.url matches process.argv[1] for the entry module.
const isEntry =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  main().catch((e) => {
    console.error("[worker] fatal:", e);
    process.exit(1);
  });
}
