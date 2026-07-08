import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healStale } from "@/lib/ownership";
import { MAX_AGENTS_PER_USER } from "@/lib/limits";
import { Dashboard } from "@/components/Dashboard";
import type { AgentView } from "@/components/types";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ zynd?: string; zynd_error?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const sp = await searchParams;
  const notice = sp.zynd_error
    ? { kind: "error" as const, text: `Zynd Persona connect failed: ${sp.zynd_error}` }
    : sp.zynd === "connected"
      ? { kind: "ok" as const, text: "Zynd Persona connected — your agent is redeploying with memory enabled." }
      : null;

  const rows = await prisma.agent.findMany({
    where: ownerWhere(user),
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true, name: true, slug: true, status: true, hostUrl: true, personalityId: true, personaLinked: true, createdAt: true },
  });
  await healStale(user, rows);
  const agents: AgentView[] = rows.map((a) => ({
    id: a.id,
    name: a.name,
    slug: a.slug,
    status: a.status,
    hostUrl: a.hostUrl,
    ...(a.personalityId ? { personalityId: a.personalityId } : {}),
    personaLinked: a.personaLinked,
    createdAt: a.createdAt.toISOString(),
  }));

  return <Dashboard initialAgents={agents} userName={user.name} maxAgents={MAX_AGENTS_PER_USER} notice={notice} />;
}
