import { NextResponse } from "next/server";
import { verifyToken } from "@hermes/deployer-worker/ws-auth";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";
import { readSecret, writeSecret } from "@/lib/secrets";
import { zyndMemoryBaseUrl, zyndOauthClientId, zyndOauthClientSecret, zyndCallbackUrl, deployerOrigin, isMissingPersonaLinkedColumn } from "@/lib/zynd";

export const runtime = "nodejs";

// Statuses whose live container must be re-driven to pick up the new ZYND token
// (the token is injected at the `starting` step). A stopped/failed agent gets
// the token on its next start, so we only re-queue an already-live one.
const REDEPLOY_FROM: ReadonlyArray<string> = ["running", "unhealthy"];

// Complete the "Connect Zynd Persona" flow: verify the signed state (login-CSRF
// defence), exchange the single-use code for a 90-day ZYND personal token,
// store it in the agent's encrypted secret, and re-queue the agent so the
// worker redeploys it memory-wired. On any failure we bounce back to the
// dashboard with a ?zynd_error message rather than failing silently.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const origin = deployerOrigin(req);

  const fail = (reason: string) =>
    NextResponse.redirect(`${origin}/?zynd_error=${encodeURIComponent(reason)}`, { status: 302 });

  const url = new URL(req.url);
  const upstreamError = url.searchParams.get("error");
  if (upstreamError) return fail(upstreamError);

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return fail("missing code or state");

  // The state is an HMAC token bound to (agentId, ownerId). It must verify AND
  // its userId must be the signed-in user — otherwise this is a forged/misrouted
  // callback and linking would attach the wrong identity to the agent.
  const verified = verifyToken(state, id);
  if (!verified.ok) return fail(`invalid state (${verified.reason})`);
  if (verified.userId !== user.id) return fail("state does not match your session");

  const agent = await prisma.agent.findFirst({
    where: { id, ...ownerWhere(user) },
    select: { id: true, userId: true, status: true, secretBlob: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);
  if (!agent.secretBlob) return fail("agent has no secret to attach the token to");

  // Exchange the code for a personal token. redirect_uri must match the one sent
  // to /authorize; the client secret proves this is the deployer redeeming it.
  let accessToken: string;
  try {
    const res = await fetch(`${zyndMemoryBaseUrl()}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: zyndOauthClientId(),
        client_secret: zyndOauthClientSecret(),
        code,
        redirect_uri: zyndCallbackUrl(origin, id),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return fail(`token exchange failed (${res.status})${detail ? `: ${detail.slice(0, 120)}` : ""}`);
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) return fail("token exchange returned no access_token");
    accessToken = data.access_token;
  } catch (e) {
    // Network/timeout/DNS — surface with context, never swallow.
    return fail(`could not reach ZYND: ${(e as Error).message}`);
  }

  // Merge the token into the agent's encrypted secret (AES-GCM in secretBlob).
  // readSecret/writeSecret are the shared worker helpers; the raw token never
  // lands in plaintext on the row or in a log line.
  try {
    const secret = await readSecret(id);
    await writeSecret(id, { ...secret, ZYND_MEMORY_TOKEN: accessToken, ZYND_MEMORY_URL: zyndMemoryBaseUrl() });
  } catch (e) {
    return fail(`could not store the ZYND token: ${(e as Error).message}`);
  }

  // Intent-only (single-writer rule): re-queue a live agent so the worker
  // redeploys with the token wired in (the worker is the only thing that touches
  // Docker), and flag it linked. Split into two updates so the redeploy trigger
  // still fires even if the personaLinked column doesn't exist yet (deploy landed
  // before the migration) — the token is already stored, so memory works on the
  // next deploy regardless of the flag.
  const redeploy = REDEPLOY_FROM.includes(agent.status);
  if (redeploy) {
    await prisma.agent.update({ where: { id }, data: { status: "queued" } });
  }
  try {
    await prisma.agent.update({ where: { id }, data: { personaLinked: true } });
  } catch (e) {
    if (!isMissingPersonaLinkedColumn(e)) throw e;
    // Column not migrated yet — token is stored + redeploy queued; the flag is
    // cosmetic (button stays "Connect"). Self-heals once the column exists.
  }

  return NextResponse.redirect(`${origin}/?zynd=connected`, { status: 302 });
}
