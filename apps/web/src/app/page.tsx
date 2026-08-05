import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healStale } from "@/lib/ownership";
import { MAX_AGENTS_PER_USER } from "@/lib/limits";
import { isMissingPersonaLinkedColumn } from "@/lib/zynd";
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

  const where = ownerWhere(user);
  const orderBy = { createdAt: "desc" } as const;
  const baseSelect = {
    id: true, userId: true, name: true, slug: true, status: true,
    hostUrl: true, personalityId: true, createdAt: true,
  } as const;

  // Read personaLinked, but tolerate its absence if the deploy landed before the
  // DB migration — fall back to defaulting it false so the dashboard still renders.
  let rows: Array<{
    id: string; userId: string; name: string; slug: string; status: string;
    hostUrl: string | null; personalityId: string | null; createdAt: Date; personaLinked: boolean;
  }>;
  try {
    rows = await prisma.agent.findMany({ where, orderBy, select: { ...baseSelect, personaLinked: true } });
  } catch (e) {
    if (!isMissingPersonaLinkedColumn(e)) throw e;
    rows = (await prisma.agent.findMany({ where, orderBy, select: baseSelect }))
      .map((r) => ({ ...r, personaLinked: false }));
  }

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
