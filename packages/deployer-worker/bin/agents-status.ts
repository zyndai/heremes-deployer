// Ops helper: list agents and their Zynd Persona memory link status.
//
// Run on the box where DATABASE_URL points (the VPS):
//   pnpm --filter @hermes/deployer-worker agents:status          # all agents
//   pnpm --filter @hermes/deployer-worker agents:status --running # running only
//
// Answers "which agents are live and which have connected memory". The Connect
// option shows for every running agent; `linked=no` means the owner hasn't
// clicked Connect yet (so nothing is ingested for it).

import { prisma } from "../src/db";

async function main(): Promise<void> {
  const runningOnly = process.argv.includes("--running");

  const agents = await prisma.agent.findMany({
    where: runningOnly ? { status: "running" } : {},
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      slug: true,
      name: true,
      status: true,
      personaLinked: true,
      ownerEmail: true,
      hostUrl: true,
    },
  });

  if (agents.length === 0) {
    console.log(runningOnly ? "No running agents." : "No agents.");
    return;
  }

  const rows = agents.map((a) => ({
    slug: a.slug,
    status: a.status,
    memory: a.personaLinked ? "linked" : "—",
    owner: a.ownerEmail ?? "?",
    name: a.name,
  }));
  console.table(rows);

  const running = agents.filter((a) => a.status === "running");
  const linkedRunning = running.filter((a) => a.personaLinked).length;
  console.log(
    `\nTotal: ${agents.length} | running: ${running.length} | ` +
      `running + memory linked: ${linkedRunning} | ` +
      `running, not yet linked: ${running.length - linkedRunning}`,
  );
  if (running.length - linkedRunning > 0) {
    console.log(
      "Unlinked running agents already show the Connect Zynd Persona button; " +
        "ingest starts the moment their owner connects.",
    );
  }
}

main()
  .catch((err) => {
    console.error("agents-status failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
