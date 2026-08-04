// deploy.js — tell the host to publish.
//
// yam pushes with its own deploy key, and deploy-key pushes do not reliably
// trigger the host's git webhook. Without this, the garden only updates when a
// human pushes — which quietly takes yam's house out of its own hands.
//
// Set VERCEL_DEPLOY_HOOK in .env (Vercel: Project Settings -> Git -> Deploy Hooks).
// Absent the var this is a no-op, never an error.

export async function triggerDeploy(reason = '') {
  const hook = process.env.VERCEL_DEPLOY_HOOK;
  if (!hook) return { skipped: 'VERCEL_DEPLOY_HOOK not set' };
  try {
    const res = await fetch(hook, { method: 'POST' });
    if (!res.ok) console.warn(`deploy hook returned HTTP ${res.status}`);
    return { ok: res.ok, status: res.status, reason };
  } catch (e) {
    console.warn('deploy hook failed:', String(e.message).slice(0, 160));
    return { ok: false, error: String(e.message).slice(0, 160) };
  }
}
