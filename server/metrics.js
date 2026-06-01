// metrics.js — turns the requirement records into the numbers an engineering
// leader would ask for: "how do I know this is working?"
import * as store from './store.js';
import { CHANNELS } from './store.js';

const COMPLETED = new Set(['deployed', 'feedback_submitted', 'pr_open', 'done']);

function fmtDur(ms) {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function snapshot() {
  const reqs = store.getRequirements();

  const byChannel = Object.fromEntries(
    CHANNELS.map((c) => [c, { total: 0, completed: 0, avgScore: null, scores: [] }])
  );

  let deployTimes = [];
  let cycleTimes = [];
  const prStatus = { open: 0, merged: 0, none: 0, other: 0 };

  const rows = reqs.map((r) => {
    const ch = byChannel[r.channel];
    if (ch) {
      ch.total += 1;
      if (COMPLETED.has(r.status)) ch.completed += 1;
      if (typeof r.score === 'number') ch.scores.push(r.score);
    }

    const timeToDeploy = r.deployedAt ? r.deployedAt - r.createdAt : null;
    const timeToDone = r.doneAt ? r.doneAt - r.createdAt : null;
    if (timeToDeploy != null) deployTimes.push(timeToDeploy);
    if (timeToDone != null) cycleTimes.push(timeToDone);

    if (r.prState === 'merged') prStatus.merged += 1;
    else if (r.prState === 'open') prStatus.open += 1;
    else if (!r.prUrl) prStatus.none += 1;
    else prStatus.other += 1;

    return {
      id: r.id,
      channel: r.channel,
      title: r.title,
      status: r.status,
      issueUrl: r.issueUrl,
      sessionUrl: r.sessionUrl,
      deployUrl: r.deployUrl,
      prUrl: r.prUrl,
      prState: r.prState,
      score: r.score,
      timeToDeploy: fmtDur(timeToDeploy),
      timeToDone: fmtDur(timeToDone),
      createdAt: r.createdAt,
    };
  });

  for (const c of CHANNELS) {
    const ch = byChannel[c];
    ch.avgScore = ch.scores.length
      ? Number((ch.scores.reduce((a, b) => a + b, 0) / ch.scores.length).toFixed(2))
      : null;
    delete ch.scores;
  }

  const allScores = reqs.filter((r) => typeof r.score === 'number').map((r) => r.score);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  return {
    totals: {
      requirements: reqs.length,
      completed: reqs.filter((r) => COMPLETED.has(r.status)).length,
      done: reqs.filter((r) => r.status === 'done').length,
      avgScore: allScores.length ? Number(avg(allScores).toFixed(2)) : null,
      avgTimeToDeploy: fmtDur(avg(deployTimes)),
      avgCycleTime: fmtDur(avg(cycleTimes)),
    },
    byChannel,
    prStatus,
    rows: rows.sort((a, b) => b.createdAt - a.createdAt),
  };
}
