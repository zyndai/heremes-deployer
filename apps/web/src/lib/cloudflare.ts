// Cloudflare account-id resolution for the create-agent flow. The Workers AI
// endpoint URL embeds the account id, so an agent on the cloudflare provider
// needs one. Rather than force the user to paste it, we derive it from the token
// they already provide: a Workers AI token is account-scoped, so listing the
// accounts it can reach returns exactly that account in the common case.

const ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts?per_page=50";

/** A recoverable "we couldn't auto-detect it — ask the user" outcome. */
export class CloudflareAccountError extends Error {}

interface AccountsResponse {
  result?: Array<{ id?: string }>;
}

/**
 * Resolve the Cloudflare account id a token belongs to.
 *
 * - Exactly one accessible account -> its id.
 * - Zero / many / token can't list accounts (403) / network error -> throw
 *   {@link CloudflareAccountError} with a message that tells the caller to fall
 *   back to a manually-entered Account ID.
 *
 * Never returns an empty string; callers can trust a resolved value.
 */
export async function resolveCloudflareAccountId(token: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(ACCOUNTS_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (cause) {
    throw new CloudflareAccountError(
      "Could not reach Cloudflare to detect your Account ID — enter it manually.",
      { cause },
    );
  }

  if (!res.ok) {
    // 403 is the common case: a token scoped to Workers AI only cannot list
    // accounts. Any non-2xx here means we can't detect it programmatically.
    throw new CloudflareAccountError(
      "This token can't list your Cloudflare accounts — enter your Account ID manually.",
    );
  }

  const body = (await res.json().catch(() => null)) as AccountsResponse | null;
  const accounts = body?.result ?? [];
  const ids = accounts.map((a) => a.id).filter((id): id is string => typeof id === "string" && id.length > 0);

  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw new CloudflareAccountError(
      "No Cloudflare account found for this token — enter your Account ID manually.",
    );
  }
  throw new CloudflareAccountError(
    "This token can access multiple Cloudflare accounts — enter the specific Account ID.",
  );
}
