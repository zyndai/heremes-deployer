import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ownerWhere, healOwnership } from "@/lib/ownership";
import { mintWsToken } from "@/lib/ws-token";
import { zyndMemoryBaseUrl, zyndOauthClientId, zyndOauthClientSecret, zyndCallbackUrl, deployerOrigin } from "@/lib/zynd";

// crypto (HMAC state signing) needs the Node runtime, not edge.
export const runtime = "nodejs";

// The signed OAuth `state` is valid for 10 minutes — long enough to sign in at
// ZYND/persona, short enough to bound a leaked state's replay window.
const STATE_TTL_SEC = 600;

// Start the "Connect Zynd Persona" flow: verify the caller owns the agent, then
// 302 to memory-layer's /oauth/authorize. The `state` is an HMAC token binding
// this agent + owner (same minter as the deploy-WS token), which the callback
// verifies to defeat login-CSRF (an attacker cannot forge a state for someone
// else's session/agent). The token exchange itself happens in the callback with
// our confidential client secret, so only this deployer can redeem the code.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  // Connect is unavailable unless the confidential client secret is configured;
  // fail loud rather than send an empty secret that would 401 at /oauth/token.
  if (!zyndOauthClientSecret()) {
    return NextResponse.json(
      { error: "Zynd Persona connect is not configured (ZYND_OAUTH_CLIENT_SECRET unset)" },
      { status: 503 },
    );
  }

  const agent = await prisma.agent.findFirst({
    where: { id, ...ownerWhere(user) },
    select: { id: true, userId: true },
  });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (agent.userId !== user.id) await healOwnership(user, agent.id);

  let state: string;
  try {
    state = mintWsToken(agent.id, user.id, STATE_TTL_SEC);
  } catch {
    // mintWsToken fails closed when DEPLOYER_WS_SECRET is unset/too short.
    return NextResponse.json(
      { error: "Zynd Persona connect is not configured (DEPLOYER_WS_SECRET unset or too short)" },
      { status: 503 },
    );
  }

  const authorize = new URL(`${zyndMemoryBaseUrl()}/oauth/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", zyndOauthClientId());
  authorize.searchParams.set("redirect_uri", zyndCallbackUrl(deployerOrigin(req), agent.id));
  authorize.searchParams.set("scope", "ingest");
  authorize.searchParams.set("state", state);
  return NextResponse.redirect(authorize.toString(), { status: 302 });
}
