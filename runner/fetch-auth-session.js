/**
 * Fetch Shopify session captured via Slack auth flow (Railway).
 */
export async function fetchSlackAuthSession(authRunId) {
  const base = process.env.QA_WEBHOOK_BASE_URL?.replace(/\/$/, '');
  const secret = process.env.AUTH_FETCH_SECRET;

  if (!authRunId || !base || !secret) {
    return null;
  }

  const res = await fetch(`${base}/api/session/${encodeURIComponent(authRunId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Auth session fetch failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const { storageState } = await res.json();
  return storageState ?? null;
}
