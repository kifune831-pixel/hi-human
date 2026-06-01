// github.js — minimal GitHub REST client over fetch (no Octokit dependency).
// Creates labelled issues, opens PRs, and reads PR state for the dashboard.

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || 'kifune831-pixel/superset';
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'master';
const API = 'https://api.github.com';

const live = !!TOKEN;

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

// Channel -> issue label. The brief specifically wants a "sales member" label.
export function channelLabel(channel) {
  return `${channel}-member`;
}

// ── Live ────────────────────────────────────────────────────────
async function liveCreateIssue({ title, body, channel }) {
  const res = await fetch(`${API}/repos/${REPO}/issues`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ title, body, labels: [channelLabel(channel)] }),
  });
  if (!res.ok) throw new Error(`GitHub issue failed ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return { number: j.number, url: j.html_url };
}

async function liveGetPr(prUrl) {
  // prUrl like https://github.com/owner/repo/pull/123
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return { state: 'unknown', url: prUrl };
  const res = await fetch(`${API}/repos/${m[1]}/pulls/${m[2]}`, { headers: headers() });
  if (!res.ok) return { state: 'unknown', url: prUrl };
  const j = await res.json();
  return { state: j.merged ? 'merged' : j.state, draft: j.draft, url: prUrl };
}

// ── Public ──────────────────────────────────────────────────────
export const isLive = live;
export const repo = REPO;
export const baseBranch = BASE_BRANCH;

export async function createIssue(args) {
  return liveCreateIssue(args);
}

export async function getPrStatus(prUrl) {
  if (!prUrl) return null;
  return liveGetPr(prUrl);
}
