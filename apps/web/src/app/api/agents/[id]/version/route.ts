import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";

export const runtime = "nodejs";

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
  body?: string;
}

// In-memory cache for the GitHub releases API to avoid rate limits.
// A 15-minute TTL is generous — Hermes doesn't release hourly.
let cachedLatest: { version: string; releaseDate: string; changelogUrl: string } | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 15 * 60 * 1000;

async function fetchLatestVersion(): Promise<{
  version: string;
  releaseDate: string;
  changelogUrl: string;
} | null> {
  if (cachedLatest && Date.now() - cacheAt < CACHE_TTL_MS) return cachedLatest;

  try {
    const res = await fetch("https://api.github.com/repos/nousresearch/hermes-agent/releases/latest", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "hermes-deployer/1.0",
        // GitHub requires a token for higher rate limits, but unauthenticated
        // gets 60 req/hr — with a 15-min cache that's 4/hr. Fine.
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const release = (await res.json()) as GitHubRelease;
    const version = release.tag_name.startsWith("v") ? release.tag_name : `v${release.tag_name}`;

    cachedLatest = {
      version,
      releaseDate: release.published_at,
      changelogUrl: release.html_url,
    };
    cacheAt = Date.now();
    return cachedLatest;
  } catch {
    // Network / timeout — return whatever we had cached last (even if stale).
    return cachedLatest;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const agent = await prisma.agent.findFirst({
    where: { id, ...ownerWhere(user) },
    select: { id: true, userId: true, hermesVersion: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);

  const latest = await fetchLatestVersion();

  return NextResponse.json({
    current: agent.hermesVersion ?? null,
    latest: latest?.version ?? null,
    releaseDate: latest?.releaseDate ?? null,
    changelogUrl: latest?.changelogUrl ?? null,
    updateAvailable: latest != null && agent.hermesVersion != null && agent.hermesVersion !== latest.version,
  });
}
