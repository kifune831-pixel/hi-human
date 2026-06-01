// devin.js — client over the Devin v3 API (org-scoped, cog_ service-user keys).
//   GET  /v3/self                                          -> resolve org_id
//   POST /v3/organizations/{org}/sessions                  -> create
//   GET  /v3/organizations/{org}/sessions/{id}             -> status, structured_output, pull_requests
//   POST /v3/organizations/{org}/sessions/{id}/messages    -> follow-up instruction
// Docs: https://docs.devin.ai/api-reference
//
// NOTE: the v3 session response does NOT expose Devin's chat transcript. The
// only machine-readable progress is `status`/`status_detail`, `structured_output`
// and `pull_requests`. So we ask Devin (see buildPrompt) to keep a short progress
// line in structured_output.summary, and the poller relays that + status changes
// into the chat channel.
//
// In DEMO_MODE we return a deterministic, time-driven simulation so the whole
// requirement -> deploy -> PR loop is observable without spending ACUs.

const DEMO = process.env.DEMO_MODE !== 'false';
const KEY = process.env.DEVIN_API_KEY;
const BASE = process.env.DEVIN_API_BASE || 'https://api.devin.ai/v3';
let ORG = process.env.DEVIN_ORG_ID || null;

const live = !DEMO && !!KEY;

function headers() {
  return {
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  };
}

// We want Devin to hand back machine-readable fields we can surface on the
// dashboard and pipe into the chat — so we ask for structured output.
const STRUCTURED_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Short human-readable line of what you are doing RIGHT NOW; keep updating it' },
    deploy_url: { type: 'string', description: 'Live URL where the deployed Superset can be used' },
    pr_url: { type: 'string', description: 'URL of the opened pull request, once created' },
  },
};

export function buildPrompt(requirement) {
  return [
    `You are working in the repository ${process.env.GITHUB_REPO || 'the target fork'} (Apache Superset).`,
    `A "${requirement.channel}" stakeholder filed this requirement:`,
    '',
    `Title: ${requirement.title}`,
    `Details: ${requirement.body}`,
    '',
    'Do the following, in order:',
    '1. Implement the requested change on a new branch in the cloned repo.',
    '2. Run Superset from this repo\'s source so your change is live. The app is already',
    '   installed editable (`pip install -e .`) and uses its default SQLite metadata DB —',
    '   no Postgres/Redis needed:',
    '     - Run in development mode so the production-only SECRET_KEY check is just a',
    '       warning (not a hard stop):  `export SUPERSET_ENV=development`.',
    '     - `superset db upgrade`, `superset fab create-admin` (admin/admin), `superset init`.',
    '     - Serve it DETACHED so it survives the command returning (a plain `&` gets',
    '       SIGHUP-killed): `setsid nohup superset run -h 0.0.0.0 -p 8088 > /tmp/superset.log 2>&1 &`.',
    '     - Only rebuild the frontend if your change is UI/theme/template:',
    '       `cd superset-frontend && npm ci && npm run build`. Config-only changes',
    '       (e.g. APP_NAME) do NOT need a frontend build.',
    '   - Wait until http://localhost:8088/health returns OK. Then get a PUBLIC url with a',
    '     cloudflared quick tunnel (do NOT use the expose_port tool — it needs manual approval).',
    '     Start it DETACHED too, or the tunnel dies and the URL returns Cloudflare error 1033:',
    '       `setsid nohup cloudflared tunnel --url http://localhost:8088 > /tmp/cf.log 2>&1 &`',
    '     Then WAIT until /tmp/cf.log shows "Registered tunnel connection" (not just the URL),',
    '     read the `https://*.trycloudflare.com` URL, and VERIFY `curl -sf "$URL/health"` works',
    '     before reporting it as deploy_url (login admin/admin).',
    '3. Wait for follow-up messages with refinements; apply them to the SAME branch and source,',
    '   then redeploy — backend/config edits just need a restart, frontend edits a `npm run build`.',
    '   Keep the same deploy_url if possible.',
    '4. When you receive a message that begins with "FEEDBACK:", open a pull request whose',
    '   description includes that feedback verbatim, then report pr_url.',
    '',
    'IMPORTANT: keep the structured_output.summary field updated at every step with a short',
    'one-line status of what you are doing (it is shown to the stakeholder in chat). Always keep',
    'deploy_url and pr_url current too.',
  ].join('\n');
}

// ── Org resolution ──────────────────────────────────────────────
async function getOrg() {
  if (ORG) return ORG;
  const res = await fetch(`${BASE}/self`, { headers: headers() });
  if (!res.ok) throw new Error(`Devin /self failed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  ORG = j.org_id;
  if (!ORG) throw new Error('Could not resolve org_id from /v3/self; set DEVIN_ORG_ID');
  return ORG;
}

// Normalize a v3 SessionResponse into the shape automation.js expects.
function normalize(s) {
  const prs = Array.isArray(s.pull_requests) ? s.pull_requests : [];
  const pr = prs[0];
  return {
    session_id: s.session_id,
    url: s.url,
    status: s.status, // new|claimed|running|exit|error|suspended|resuming
    status_detail: s.status_detail || null, // working|waiting_for_user|finished|...
    structured_output: s.structured_output || null,
    pull_request: pr ? { url: pr.pr_url, state: pr.pr_state } : null,
    acus_consumed: s.acus_consumed,
  };
}

// ── Live calls ──────────────────────────────────────────────────
async function liveCreate(prompt, tags, title) {
  const org = await getOrg();
  const res = await fetch(`${BASE}/organizations/${org}/sessions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      prompt,
      title,
      tags,
      structured_output_required: true,
      structured_output_schema: STRUCTURED_OUTPUT_SCHEMA,
    }),
  });
  if (!res.ok) throw new Error(`Devin create failed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { session_id: j.session_id, url: j.url, is_new_session: true };
}

async function liveGet(sessionId) {
  const org = await getOrg();
  const res = await fetch(`${BASE}/organizations/${org}/sessions/${sessionId}`, { headers: headers() });
  if (!res.ok) throw new Error(`Devin get failed ${res.status}: ${await res.text()}`);
  return normalize(await res.json());
}

async function liveMessage(sessionId, message) {
  const org = await getOrg();
  const res = await fetch(`${BASE}/organizations/${org}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Devin message failed ${res.status}: ${await res.text()}`);
  return { ok: true };
}

// ── Mock simulation ─────────────────────────────────────────────
// Session lifecycle is purely a function of elapsed time since creation,
// so polling produces a believable working -> finished progression, with a
// changing `summary` so the chat relay has something to show.
const mockSessions = new Map();

function mockCreate(prompt, tags, title) {
  const id = `devin-${Math.random().toString(36).slice(2, 10)}`;
  mockSessions.set(id, { createdAt: Date.now(), feedbackAt: null, title });
  return { session_id: id, url: `https://app.devin.ai/sessions/${id}`, is_new_session: true };
}

function mockGet(sessionId) {
  const s = mockSessions.get(sessionId);
  if (!s) return normalize({ session_id: sessionId, status: 'exit', pull_requests: [] });
  const elapsed = Date.now() - s.createdAt;
  const structured = {};
  let status = 'running';
  let status_detail = 'working';

  // Evolving progress line for the chat relay.
  if (elapsed < 4_000) structured.summary = 'Cloning the repo and implementing the change on a new branch…';
  else if (elapsed < 8_000) structured.summary = 'Installing deps and running superset db upgrade / init…';
  else if (elapsed < 12_000) structured.summary = 'Building the frontend and starting Superset on :8088…';
  else structured.summary = `Deployed — ${s.title}. Try it and send refinements.`;

  // ~12s in: environment is deployed and usable.
  let pull_requests = [];
  if (elapsed > 12_000) {
    structured.deploy_url = `https://${sessionId}.preview.devin.dev`;
    status_detail = 'waiting_for_user';
  }
  // PR only opens after feedback has been submitted (mirrors the prompt's step 4).
  if (s.feedbackAt && Date.now() - s.feedbackAt > 6_000) {
    const prUrl = `https://github.com/${process.env.GITHUB_REPO || 'kifune831-pixel/superset'}/pull/${
      100 + (parseInt(sessionId.slice(-3), 36) % 800)
    }`;
    structured.summary = 'Opened the pull request with your feedback embedded.';
    structured.pr_url = prUrl;
    pull_requests = [{ pr_url: prUrl, pr_state: 'open' }];
    status = 'exit';
    status_detail = 'finished';
  }

  return normalize({
    session_id: sessionId,
    url: `https://app.devin.ai/sessions/${sessionId}`,
    status,
    status_detail,
    structured_output: Object.keys(structured).length ? structured : null,
    pull_requests,
    acus_consumed: Math.round(elapsed / 1000),
  });
}

function mockMessage(sessionId, message) {
  const s = mockSessions.get(sessionId);
  if (s && /^FEEDBACK:/i.test(message)) s.feedbackAt = Date.now();
  return { ok: true };
}

// ── Public surface ──────────────────────────────────────────────
export const isLive = live;

export async function createSession({ prompt, tags, title }) {
  return live ? liveCreate(prompt, tags, title) : mockCreate(prompt, tags, title);
}

export async function getSession(sessionId) {
  return live ? liveGet(sessionId) : mockGet(sessionId);
}

export async function sendMessage(sessionId, message) {
  return live ? liveMessage(sessionId, message) : mockMessage(sessionId, message);
}
