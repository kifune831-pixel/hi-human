// index.js — HTTP surface for the chat console, the automation, and the dashboard.
import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as store from './store.js';
import { CHANNELS } from './store.js';
import * as automation from './automation.js';
import * as metrics from './metrics.js';
import * as devin from './devin.js';
import * as github from './github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Keep the raw body so we can verify GitHub webhook signatures.
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));
app.use(express.static(join(__dirname, '..', 'public')));

// ── Chat ────────────────────────────────────────────────────────
app.get('/api/channels', (_req, res) => {
  res.json({
    channels: CHANNELS,
    mode: devin.isLive || github.isLive ? 'live' : 'demo',
    repo: github.repo,
  });
});

app.get('/api/messages/:channel', (req, res) => {
  if (!CHANNELS.includes(req.params.channel)) return res.status(404).json({ error: 'unknown channel' });
  res.json(store.getMessages(req.params.channel));
});

// Plain message — posted "as" the channel identity.
app.post('/api/messages', (req, res) => {
  const { channel, text } = req.body || {};
  if (!CHANNELS.includes(channel) || !text?.trim()) return res.status(400).json({ error: 'bad request' });
  const msg = store.addMessage(channel, {
    id: crypto.randomUUID(),
    channel,
    author: channel,
    text: text.trim(),
    kind: 'user',
    ts: Date.now(),
  });
  res.json(msg);
});

// ── Requirements / automation ───────────────────────────────────
// Promote a message into a tracked requirement. This is the chat trigger.
app.post('/api/requirements', async (req, res) => {
  const { channel, title, body } = req.body || {};
  if (!CHANNELS.includes(channel) || !title?.trim()) return res.status(400).json({ error: 'bad request' });
  // Echo the ask into the channel as the member, then fire the event.
  store.addMessage(channel, {
    id: crypto.randomUUID(),
    channel,
    author: channel,
    text: `📨 New requirement: ${title}${body ? `\n${body}` : ''}`,
    kind: 'user',
    ts: Date.now(),
  });
  const requirement = await automation.handleRequirementCreated({
    channel,
    title: title.trim(),
    body: (body || '').trim(),
    author: channel,
  });
  res.json(requirement);
});

app.get('/api/requirements', (_req, res) => res.json(store.getRequirements()));

app.post('/api/requirements/:id/followup', async (req, res) => {
  try {
    const r = await automation.sendFollowUp(req.params.id, (req.body?.text || '').trim(), req.body?.author);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/requirements/:id/feedback', async (req, res) => {
  const score = Number(req.body?.score);
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: 'score must be 1-5' });
  try {
    const r = await automation.submitFeedback(req.params.id, score, req.body?.comment, req.body?.author);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Dashboard ───────────────────────────────────────────────────
app.get('/api/metrics', (_req, res) => res.json(metrics.snapshot()));

// ── GitHub webhook (external event trigger) ─────────────────────
// Point a GitHub `issues` webhook here (use smee.io / ngrok for local dev).
// An opened issue carrying a `<channel>-member` label starts the same flow.
app.post('/webhook/github', (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.get('X-Hub-Signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return res.status(401).json({ error: 'bad signature' });
    }
  }
  const event = req.get('X-GitHub-Event');
  const { action, issue } = req.body || {};
  if (event === 'issues' && action === 'opened' && issue) {
    const label = (issue.labels || []).map((l) => l.name).find((n) => /-member$/.test(n));
    const channel = label ? label.replace(/-member$/, '') : null;
    if (channel && CHANNELS.includes(channel)) {
      automation.bus.emit('requirement.created', {
        channel,
        title: issue.title,
        body: issue.body || '',
        author: issue.user?.login,
        issue: { number: issue.number, url: issue.html_url },
      });
      return res.json({ accepted: true, channel });
    }
  }
  res.json({ accepted: false });
});

app.listen(PORT, () => {
  const mode = devin.isLive || github.isLive ? 'LIVE' : 'DEMO';
  console.log(`hi-human listening on http://localhost:${PORT}  [${mode} mode]`);
  if (mode === 'DEMO') console.log('   No credentials set — GitHub + Devin are simulated end-to-end.');
  automation.startPoller();
});
