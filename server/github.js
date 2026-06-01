// github.js — minimal GitHub REST client over fetch (no Octokit dependency).
// Creates labelled issues, opens PRs, and reads PR state for the dashboard.
// Mocked in DEMO_MODE.

const DEMO = process.env.DEMO_MODE !== 'false';
const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO || 'kifune831-pixel/superset';
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'master';
const API = 'https://api.github.com';

const live = !DEMO && !!TOKEN;

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

// ── Mock ────────────────────────────────────────────────────────
let mockIssueNo = 4200;
const mockPrState = new Map();

function mockCreateIssue({ title }) {
  const number = ++mockIssueNo;
  return { number, url: `https://github.com/${REPO}/issues/${number}` };
}

function mockGetPr(prUrl) {
  // First read: open. ~15s later: merged. Lets the dashboard show movement.
  if (!mockPrState.has(prUrl)) mockPrState.set(prUrl, Date.now());
  const age = Date.now() - mockPrState.get(prUrl);
  return { state: age > 15_000 ? 'merged' : 'open', draft: false, url: prUrl };
}

// ── Public ──────────────────────────────────────────────────────
export const isLive = live;
export const repo = REPO;
export const baseBranch = BASE_BRANCH;

export async function createIssue(args) {
  return live ? liveCreateIssue(args) : mockCreateIssue(args);
}

export async function getPrStatus(prUrl) {
  if (!prUrl) return null;
  return live ? liveGetPr(prUrl) : mockGetPr(prUrl);
}
