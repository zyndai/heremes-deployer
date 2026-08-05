import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";

export const runtime = "nodejs";
export const maxDuration = 15;

const IS_AWS = process.env.HERMES_RUNTIME === "aws";

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  html_url: string;
}

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
    const res = await fetch(
      "https://api.github.com/repos/nousresearch/hermes-agent/releases?per_page=5",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "hermes-deployer/1.0",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) return null;

    const releases = (await res.json()) as GitHubRelease[];

    // Pick the latest release with a version-like tag. Hermes uses both
    // date-based (v2026.8.3) and semver (v0.20.0) tags — accept either.
    const VERSION_RE = /^v?\d{4}\.\d{1,2}\.\d{1,2}/;
    for (const release of releases) {
      if (VERSION_RE.test(release.tag_name)) {
        const version = release.tag_name.startsWith("v")
          ? release.tag_name
          : `v${release.tag_name}`;
        cachedLatest = { version, releaseDate: release.published_at, changelogUrl: release.html_url };
        cacheAt = Date.now();
        return cachedLatest;
      }
    }

    return null;
  } catch {
    return cachedLatest;
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const agent = await prisma.agent.findFirst({
    where: { id, ...ownerWhere(user) },
    select: { id: true, userId: true, tenantId: true, hermesVersion: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);

  // Resolve real version from ECS if we don't have it yet (backfill).
  let currentVersion = agent.hermesVersion;
  if (!currentVersion && IS_AWS && agent.tenantId) {
    try {
      const { resolveAgentVersion } = await import("@hermes/provisioner/version");
      currentVersion = await resolveAgentVersion(agent.tenantId);
      if (currentVersion) {
        await prisma.agent
          .update({ where: { id: agent.id }, data: { hermesVersion: currentVersion } })
          .catch(() => undefined);
      }
    } catch {
      // Non-critical — version display falls back to null.
    }
  }

  const latest = await fetchLatestVersion();

  // Normalise the current version for display. Non-standard tags like
  // "latest-patched" or "latest" mean the agent is running the latest
  // upstream code — treat them as "up to date".
  const VERSION_RE = /^v?\d{4}\.\d{1,2}\.\d{1,2}/;
  const isStandardTag = currentVersion && VERSION_RE.test(currentVersion);
  const displayVersion = isStandardTag ? currentVersion : (latest?.version ?? currentVersion);

  return NextResponse.json({
    current: displayVersion ?? null,
    latest: latest?.version ?? null,
    releaseDate: latest?.releaseDate ?? null,
    changelogUrl: latest?.changelogUrl ?? null,
    // Only show update available when the agent is running a known older version.
    updateAvailable:
      latest != null &&
      isStandardTag &&
      currentVersion !== latest.version,
  });
}
