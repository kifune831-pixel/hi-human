// e2e.mjs — drive the whole pipeline against a running server.
const B = `http://localhost:${process.env.PORT || 3055}`;
const j = (p, opts) => fetch(B + p, opts).then((r) => r.json());
const post = (p, body) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const reqOf = async (id) => (await j('/api/requirements')).find((r) => r.id === id);

(async () => {
  log('channels:', JSON.stringify(await j('/api/channels')));

  // 1. sales files a requirement (chat trigger)
  const r = await post('/api/requirements', { channel: 'sales', title: 'Add CSV export button to dashboards' });
  log('\n[1] requirement created:', r.id, '| status:', r.status, '| issue:', r.issueNumber, '| session:', !!r.sessionId);

  // 2. wait for deploy (~12s mock)
  await sleep(14000);
  let cur = await reqOf(r.id);
  log('[2] after deploy -> status:', cur.status, '| deployUrl:', cur.deployUrl);

  // 3. a follow-up refinement
  await post(`/api/requirements/${r.id}/followup`, { text: 'Make the button also export to XLSX', author: 'sales' });
  log('[3] follow-up sent');

  // 4. satisfied -> feedback + PR
  await post(`/api/requirements/${r.id}/feedback`, { score: 5, comment: 'Exactly what we needed', author: 'sales' });
  log('[4] feedback submitted (5/5)');

  // 5. wait for PR (~6s after feedback) then merge (~15s after first read)
  await sleep(9000);
  cur = await reqOf(r.id);
  log('[5] after PR -> status:', cur.status, '| prUrl:', cur.prUrl, '| prState:', cur.prState);

  // 6. second requirement on a different channel for the dashboard
  await post('/api/requirements', { channel: 'tech', title: 'Upgrade Flask dependency to patch CVE' });

  await sleep(18000); // let PR merge + tech deploy progress
  const m = await j('/api/metrics');
  log('\n[6] METRICS');
  log('  totals:', JSON.stringify(m.totals));
  log('  byChannel.sales:', JSON.stringify(m.byChannel.sales));
  log('  byChannel.tech:', JSON.stringify(m.byChannel.tech));
  log('  prStatus:', JSON.stringify(m.prStatus));
  log('  ledger rows:', m.rows.length);
  for (const row of m.rows) log(`    #${row.channel} "${row.title}" status=${row.status} prState=${row.prState} deploy=${row.timeToDeploy} cycle=${row.timeToDone} score=${row.score}`);

  log('\n[7] sales chat transcript:');
  const msgs = await j('/api/messages/sales');
  for (const mm of msgs) log(`    [${mm.kind}] ${mm.author}: ${mm.text.split('\n')[0]}`);

  log('\nE2E OK');
})().catch((e) => { console.error('E2E FAIL', e); process.exit(1); });
