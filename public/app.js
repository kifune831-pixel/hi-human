// app.js — vanilla client for the hi-human console.
const META = {
  sales:      { icon: '💼', desc: 'pipeline & customer asks' },
  operations: { icon: '⚙️', desc: 'process & internal tooling' },
  tech:       { icon: '🛠️', desc: 'platform & engineering' },
};

const state = { view: 'sales', channels: [], mode: 'demo', reqs: [], metrics: null, stars: {} };
const $ = (s, el = document) => el.querySelector(s);
const api = (p, opts) => fetch(p, opts).then((r) => r.json());
const esc = (s) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

async function boot() {
  const info = await api('/api/channels');
  state.channels = info.channels;
  state.mode = info.mode;
  state.repo = info.repo;
  const badge = $('#mode');
  badge.textContent = info.mode === 'live' ? '● live' : '● demo';
  badge.className = `mode ${info.mode}`;
  renderRail();
  bindRail();
  await refresh();
  render();
  setInterval(tick, 3000);
}

function renderRail() {
  $('#channelBlocks').innerHTML = state.channels
    .map(
      (c) => `
    <button class="block" data-view="${c}">
      <span class="count" id="count-${c}">0</span>
      <div class="icon">${META[c]?.icon || '#'}</div>
      <div class="name">#${c}</div>
      <div class="desc">${META[c]?.desc || ''}</div>
    </button>`
    )
    .join('');
}

function bindRail() {
  document.querySelectorAll('.block').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      render();
    })
  );
}

function markActive() {
  document.querySelectorAll('.block').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view)
  );
  state.channels.forEach((c) => {
    const n = state.reqs.filter((r) => r.channel === c).length;
    const el = $(`#count-${c}`);
    if (el) el.textContent = n;
  });
}

async function refresh() {
  state.reqs = await api('/api/requirements');
  state.metrics = await api('/api/metrics');
}

async function tick() {
  await refresh();
  if (state.view === 'dashboard') renderDashboard();
  else {
    state.msgs = await api(`/api/messages/${state.view}`);
    renderMessages();
    renderReqs();
    markActive();
  }
}

function render() {
  markActive();
  if (state.view === 'dashboard') renderDashboard();
  else renderChannel();
}

// ── Channel chat view ───────────────────────────────────────────
async function renderChannel() {
  const ch = state.view;
  state.msgs = await api(`/api/messages/${ch}`);
  $('#main').innerHTML = `
    <div class="panel-head">
      <h2><span class="hash">#</span>${ch}</h2>
      <span class="sub">posting as <b>${ch}</b> · ${esc(state.repo || '')}</span>
    </div>
    <div class="scroll" id="scroll"></div>
    <div class="reqs" id="reqs"></div>
    <div class="composer">
      <div class="row">
        <input type="text" id="msgInput" placeholder="Message #${ch} as ${ch}…" />
        <button id="sendBtn">Send</button>
        <button class="primary" id="reqBtn">Submit as requirement →</button>
      </div>
    </div>`;
  $('#sendBtn').onclick = sendMessage;
  $('#reqBtn').onclick = submitRequirement;
  $('#msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
  renderMessages();
  renderReqs();
}

function renderMessages() {
  const box = $('#scroll');
  if (!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = (state.msgs || [])
    .map(
      (m) => `
    <div class="msg ${m.kind}">
      <div class="meta"><span class="who">${m.author}</span><span>${time(m.ts)}</span></div>
      <div class="bubble">${linkify(m.text)}</div>
    </div>`
    )
    .join('') || `<div class="empty">No messages yet. Say something as #${state.view}.</div>`;
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderReqs() {
  const box = $('#reqs');
  if (!box) return;
  const mine = state.reqs.filter((r) => r.channel === state.view);
  if (!mine.length) { box.innerHTML = ''; return; }

  // The poller rebuilds this subtree every few seconds. Without this, an input
  // being typed into (follow-up / feedback comment) loses focus and its text.
  const active = document.activeElement;
  const saved = active && box.contains(active) && active.id
    ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd }
    : null;

  box.innerHTML =
    `<div class="reqs-title">Requirements in #${state.view}</div>` +
    mine
      .slice()
      .reverse()
      .map((r) => reqCard(r))
      .join('');
  mine.forEach((r) => wireReqCard(r));

  if (saved) {
    const el = document.getElementById(saved.id);
    if (el) {
      el.value = saved.value;
      el.focus();
      try { el.setSelectionRange(saved.start, saved.end); } catch {}
    }
  }
}

function reqCard(r) {
  const links = [];
  if (r.issueUrl) links.push(`<span><span class="k">issue</span><a href="${r.issueUrl}" target="_blank">#${r.issueNumber}</a></span>`);
  if (r.sessionUrl) links.push(`<span><span class="k">devin</span><a href="${r.sessionUrl}" target="_blank">session</a></span>`);
  if (r.deployUrl) links.push(`<span><span class="k">deploy</span><a href="${r.deployUrl}" target="_blank">open ↗</a></span>`);
  if (r.prUrl) links.push(`<span><span class="k">pr</span><a href="${r.prUrl}" target="_blank">${r.prState || 'open'}</a></span>`);

  const canFollow = r.sessionId && r.status !== 'done';
  const feedback =
    r.score
      ? `<div class="row"><span class="scored">★ ${r.score}/5 submitted</span></div>`
      : r.deployUrl
      ? `<div class="row" data-fb="${r.id}">
           <span class="stars" id="stars-${r.id}">${[1,2,3,4,5].map((n)=>`<span class="star" data-n="${n}">★</span>`).join('')}</span>
           <input type="text" id="fbc-${r.id}" placeholder="optional comment…" />
           <button class="primary" id="fbbtn-${r.id}">Submit feedback &amp; ship PR</button>
         </div>`
      : '';

  return `
    <div class="req">
      <div class="top">
        <span class="rtitle">${esc(r.title)}</span>
        <span class="badge ${r.status}">${(r.status || '').replace(/_/g, ' ')}</span>
      </div>
      ${links.length ? `<div class="links">${links.join('')}</div>` : ''}
      ${canFollow ? `<div class="row">
          <input type="text" id="fu-${r.id}" placeholder="Add a refinement for Devin…" />
          <button id="fubtn-${r.id}">Send to Devin</button>
        </div>` : ''}
      ${feedback}
    </div>`;
}

function wireReqCard(r) {
  const fu = $(`#fubtn-${r.id}`);
  if (fu) fu.onclick = async () => {
    const text = $(`#fu-${r.id}`).value.trim();
    if (!text) return;
    fu.disabled = true;
    await api(`/api/requirements/${r.id}/followup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author: r.channel }),
    });
    await tick();
  };

  const starBox = $(`#stars-${r.id}`);
  if (starBox) {
    starBox.querySelectorAll('.star').forEach((s) =>
      s.addEventListener('click', () => {
        state.stars[r.id] = Number(s.dataset.n);
        starBox.querySelectorAll('.star').forEach((x) =>
          x.classList.toggle('on', Number(x.dataset.n) <= state.stars[r.id])
        );
      })
    );
  }
  const fb = $(`#fbbtn-${r.id}`);
  if (fb) fb.onclick = async () => {
    const score = state.stars[r.id];
    if (!score) return alert('Pick a rating 1–5 first.');
    fb.disabled = true;
    await api(`/api/requirements/${r.id}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, comment: $(`#fbc-${r.id}`).value.trim(), author: r.channel }),
    });
    await tick();
  };
}

async function sendMessage() {
  const inp = $('#msgInput');
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  await api('/api/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: state.view, text }),
  });
  await tick();
}

async function submitRequirement() {
  const inp = $('#msgInput');
  const title = inp.value.trim();
  if (!title) return alert('Type the requirement first, then submit it.');
  inp.value = '';
  await api('/api/requirements', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: state.view, title }),
  });
  await tick();
}

// ── Dashboard view ──────────────────────────────────────────────
function renderDashboard() {
  const m = state.metrics;
  if (!m) return;
  const t = m.totals;
  const maxCh = Math.max(1, ...state.channels.map((c) => m.byChannel[c].total));
  const prTotal = Math.max(1, m.prStatus.open + m.prStatus.merged + m.prStatus.other);

  const tiles = [
    { v: t.requirements, l: 'requirements', cls: '' },
    { v: t.completed, l: 'in-flight / done', cls: 'teal' },
    { v: t.done, l: 'merged & done', cls: 'green' },
    { v: t.avgScore ?? '—', l: 'avg user score', cls: 'amber' },
    { v: t.avgTimeToDeploy ?? '—', l: 'avg time to deploy', cls: '' },
    { v: t.avgCycleTime ?? '—', l: 'avg cycle time', cls: '' },
  ];

  $('#main').innerHTML = `
    <div class="panel-head"><h2>📊 Dashboard</h2><span class="sub">if I led this team, here's how I'd know it works</span></div>
    <div class="dash-wrap">
      <div class="tiles">
        ${tiles.map((x) => `<div class="tile"><div class="v ${x.cls}">${x.v}</div><div class="l">${x.l}</div></div>`).join('')}
      </div>
      <div class="cols">
        <div class="card">
          <h3>Requirements by channel</h3>
          ${state.channels.map((c) => {
            const ch = m.byChannel[c];
            return `<div class="bar-row">
              <span class="nm">#${c}</span>
              <span class="bar"><i style="width:${(ch.total / maxCh) * 100}%"></i></span>
              <span class="val">${ch.completed}/${ch.total}${ch.avgScore != null ? ` · ★${ch.avgScore}` : ''}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="card">
          <h3>Pull request status</h3>
          ${[['merged', m.prStatus.merged, 'var(--green)'], ['open', m.prStatus.open, 'var(--blue)'], ['no PR yet', m.prStatus.none, 'var(--faint)']]
            .map(([nm, v, col]) => `<div class="bar-row">
              <span class="nm">${nm}</span>
              <span class="bar"><i style="width:${(v / prTotal) * 100}%;background:${col}"></i></span>
              <span class="val">${v}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h3>Requirement ledger</h3>
        ${m.rows.length ? `<table>
          <thead><tr><th>Channel</th><th>Requirement</th><th>Status</th><th>To deploy</th><th>Cycle</th><th>Score</th><th>Links</th></tr></thead>
          <tbody>
          ${m.rows.map((r) => `<tr>
            <td>#${r.channel}</td>
            <td>${esc(r.title)}</td>
            <td><span class="pill ${r.prState || r.status}">${(r.prState || r.status || '').replace(/_/g, ' ')}</span></td>
            <td>${r.timeToDeploy || '—'}</td>
            <td>${r.timeToDone || '—'}</td>
            <td>${r.score ? `★${r.score}` : '—'}</td>
            <td>${[r.issueUrl && `<a href="${r.issueUrl}" target="_blank">issue</a>`, r.deployUrl && `<a href="${r.deployUrl}" target="_blank">app</a>`, r.prUrl && `<a href="${r.prUrl}" target="_blank">pr</a>`].filter(Boolean).join(' · ') || '—'}</td>
          </tr>`).join('')}
          </tbody></table>` : '<div class="empty">No requirements yet — submit one from a channel to see the pipeline fill in.</div>'}
      </div>
    </div>`;
}

boot();
