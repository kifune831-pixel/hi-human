// automation.js — the event-driven core.
//
// Trigger surface (any of these emit `requirement.created`):
//   • chat: a sales/ops/tech member promotes a message to a requirement
//   • webhook: GitHub `issues.opened` with a *-member label (see index.js)
//
// On that event the orchestrator:
//   1. opens a labelled GitHub issue (skipped if the event already is one)
//   2. starts a Devin session pointed at the fork
//   3. surfaces Devin's deploy URL + PR back into the originating channel
// A periodic poller drives every active session's status forward — this is
// the "scan / periodic trigger" half of the event model and the source of
// the dashboard's live numbers.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as store from './store.js';
import * as devin from './devin.js';
import * as github from './github.js';

export const bus = new EventEmitter();
const POLL = Number(process.env.POLL_INTERVAL_MS || 8000);

function post(channel, author, text, kind) {
  return store.addMessage(channel, {
    id: randomUUID(),
    channel,
    author,
    text,
    kind, // 'user' | 'devin' | 'system'
    ts: Date.now(),
  });
}

function note(req, text) {
  req.events = req.events || [];
  req.events.push({ ts: Date.now(), text });
}

// ── Entry point: someone filed a requirement ────────────────────
// `source` is 'chat' or 'github'. When it's already a GitHub issue we don't
// re-create one.
export async function handleRequirementCreated({ channel, title, body, author, issue }) {
  const req = store.addRequirement({
    id: randomUUID(),
    channel,
    title,
    body,
    author: author || channel,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    issueNumber: issue?.number ?? null,
    issueUrl: issue?.url ?? null,
    sessionId: null,
    sessionUrl: null,
    deployUrl: null,
    deployedAt: null,
    prUrl: null,
    prState: null,
    score: null,
    feedbackComment: null,
    feedbackAt: null,
    doneAt: null,
    lastSummary: null,
    lastStatusDetail: null,
    events: [],
  });

  try {
    note(req, `Requirement filed in #${channel}`);
    post(channel, 'system', `📋 Requirement logged. Handing it to Devin…`, 'system');

    // Kick off a Devin session.
    const prompt = devin.buildPrompt(store.getRequirement(req.id));
    const session = await devin.createSession({
      prompt,
      title: `[${channel}] ${title}`.slice(0, 120),
      tags: [`channel:${channel}`, `req:${req.id}`],
    });
    store.updateRequirement(req.id, {
      sessionId: session.session_id,
      sessionUrl: session.url,
      status: 'session_started',
    });
    note(req, `Started Devin session ${session.session_id}`);
    post(channel, 'devin', `🤖 Devin picked this up — building & deploying now. Session: ${session.url}`, 'devin');
  } catch (err) {
    store.updateRequirement(req.id, { status: 'error', error: String(err.message || err) });
    post(channel, 'system', `⚠️ Automation error: ${err.message}`, 'system');
  }

  return store.getRequirement(req.id);
}

// ── Follow-up refinement from a stakeholder ─────────────────────
export async function sendFollowUp(requirementId, text, author) {
  const req = store.getRequirement(requirementId);
  if (!req?.sessionId) throw new Error('No active session for this requirement');
  post(req.channel, 'user', text, 'user');
  await devin.sendMessage(req.sessionId, text);
  note(req, 'Sent follow-up to Devin');
  store.updateRequirement(req.id, {});
  post(req.channel, 'devin', '🤖 Got it — applying that and redeploying.', 'devin');
  return req;
}

// ── Stakeholder is satisfied: rate it, trigger the PR ───────────
export async function submitFeedback(requirementId, score, comment, author) {
  const req = store.getRequirement(requirementId);
  if (!req) throw new Error('Requirement not found');
  store.updateRequirement(req.id, {
    score: Number(score),
    feedbackComment: comment || '',
    feedbackAt: Date.now(),
    status: 'feedback_submitted',
  });
  // The "FEEDBACK:" prefix is the contract from the Devin prompt: it tells the
  // session to open a PR with this text embedded in the description.
  const msg = `FEEDBACK: ${score}/5 from ${author || req.channel}. ${comment || ''}`.trim();
  if (req.sessionId) await devin.sendMessage(req.sessionId, msg);
  note(req, `Feedback ${score}/5 submitted; PR requested`);
  post(req.channel, 'system', `⭐ Feedback recorded (${score}/5). Asking Devin to open the PR with it attached.`, 'system');
  return store.getRequirement(req.id);
}

// ── Poller: advance every active session ────────────────────────
async function pollOnce() {
  const active = store
    .getRequirements()
    .filter((r) => r.sessionId && !['done', 'error'].includes(r.status));

  for (const req of active) {
    try {
      const s = await devin.getSession(req.sessionId);
      const out = s.structured_output || {};

      // Relay Devin's own progress line into the channel. The v3 API exposes no
      // chat transcript, so structured_output.summary is our "Devin says" feed.
      if (out.summary && out.summary !== req.lastSummary) {
        store.updateRequirement(req.id, { lastSummary: out.summary });
        post(req.channel, 'devin', `🤖 ${out.summary}`, 'devin');
      }

      // Relay notable status transitions (working is the noisy default — skip it).
      if (s.status_detail && s.status_detail !== req.lastStatusDetail) {
        store.updateRequirement(req.id, { lastStatusDetail: s.status_detail });
        const human = {
          waiting_for_user: '🟡 Devin is waiting for your input.',
          waiting_for_approval: '🟡 Devin is waiting for an approval.',
          blocked: '⚠️ Devin is blocked — it may need a nudge.',
          suspended: '⏸️ Devin paused the session (inactivity / limit).',
        }[s.status_detail];
        if (human) post(req.channel, 'system', human, 'system');
      }

      // Deploy URL appeared -> tell the stakeholder they can start using it.
      if (out.deploy_url && !req.deployUrl) {
        store.updateRequirement(req.id, {
          deployUrl: out.deploy_url,
          deployedAt: Date.now(),
          status: req.status === 'session_started' ? 'deployed' : req.status,
        });
        note(req, 'Environment deployed');
        post(
          req.channel,
          'devin',
          `🚀 Your Superset environment is live: ${out.deploy_url}\nTry it out and reply here with any changes, or submit feedback when you're happy.`,
          'devin'
        );
      }

      // PR appeared (via structured output or pull_request field).
      const prUrl = out.pr_url || s.pull_request?.url;
      if (prUrl && !req.prUrl) {
        store.updateRequirement(req.id, { prUrl, status: 'pr_open' });
        note(req, `PR opened: ${prUrl}`);
        post(req.channel, 'devin', `🔀 Pull request opened (feedback included): ${prUrl}`, 'devin');
      }

      // Refresh PR state for the dashboard from Devin's own view of the PR
      // (we never call the GitHub API). Demo mode falls back to the mock.
      if (req.prUrl || prUrl) {
        const prState = devin.isLive
          ? s.pull_request?.state || 'open'
          : (await github.getPrStatus(req.prUrl || prUrl))?.state;
        if (prState) {
          const wasMerged = req.prState === 'merged';
          store.updateRequirement(req.id, { prState });
          if (prState === 'merged' && !wasMerged) {
            store.updateRequirement(req.id, { status: 'done', doneAt: Date.now() });
            note(req, 'PR merged — requirement complete');
            post(req.channel, 'system', `✅ PR merged. "${req.title}" is done.`, 'system');
          }
        }
      }
    } catch (err) {
      note(req, `Poll error: ${err.message}`);
    }
  }
}

export function startPoller() {
  setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL);
}

// Wire the event bus to the handler.
bus.on('requirement.created', (payload) => {
  handleRequirementCreated(payload).catch(() => {});
});
