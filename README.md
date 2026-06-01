# hi-human

## Why this matters

The expensive part of most internal/customer requests isn't the code — it's the **translation tax**: a stakeholder describes a need, a PM reframes it, an engineer context-switches, builds, deploys a preview, waits for feedback, revises. hi-human collapses that loop. The stakeholder talks to the channel; **Devin is the engineer**. Humans stay in the loop exactly where they add value — describing the need and judging the result — and nowhere else.

This is only practical with an *autonomous* coding agent: it has to read an unfamiliar large codebase (Superset), implement across files, **deploy a running instance**, take follow-up instructions, and open a PR. That's the whole job, not a snippet.

---

## Architecture

```
  Chat channel (#sales / #operations / #tech)        GitHub webhook (issues.opened, *-member label)
            │  promote message → requirement                     │
            └───────────────┬─────────────────────────────────--┘
                            ▼
                    requirement.created  (EventEmitter bus)
                            ▼
                ┌───────────────────────────┐
                │   automation.js (orchestrator) │
                │   1. open labelled GitHub issue│
                │   2. create Devin session      │ ── Devin v1 API ──▶ builds + DEPLOYS Superset
                │   3. surface deploy URL to chat │
                └───────────────────────────┘
                            ▲  periodic poller (scan trigger)
                            │  GET /v1/sessions/{id} → structured_output{deploy_url, pr_url}, pull_request
   stakeholder iterates ────┘                                   │
   stakeholder rates 1–5 → "FEEDBACK:" message → Devin opens PR with feedback embedded
                            ▼
              metrics.js  →  /api/metrics  →  Dashboard
```

**Two event triggers, one handler.** Chat promotion and the GitHub webhook both emit the same `requirement.created` event. The status **poller** is the second half of the event model — the "scan / periodic" trigger that drives every session forward and feeds the dashboard.

**Devin as the primitive, not a helper.** The orchestrator never writes code. It hands Devin a structured prompt (`server/devin.js → buildPrompt`) and asks for `structured_output` (`summary`, `deploy_url`, `pr_url`) so the app can pipe Devin's results straight into chat and onto the dashboard. PR status comes from Devin's `pull_request` field and the GitHub API.

| File | Responsibility |
|---|---|
| `server/index.js` | HTTP API, static UI, GitHub webhook receiver |
| `server/automation.js` | Event bus, orchestration, status poller |
| `server/devin.js` | Devin v1 client (`create` / `get` / `messages`) + demo simulation |
| `server/github.js` | GitHub REST (issue / PR status) + demo simulation |
| `server/metrics.js` | Dashboard aggregation (counts, timing, PR state, scores) |
| `server/store.js` | "Simplest JSON storage" — `data/*.json` |
| `public/` | Vanilla-JS chat console + dashboard |

---

## Run it

### With Docker (recommended)

```bash
docker compose up --build           # → http://localhost:3000
```

Compose reads config from `.env` and persists the JSON store via the `./data` volume. To run the image directly without compose:

```bash
docker build -t hi-human .
docker run --rm -p 3000:3000 --env-file .env -v "$PWD/data:/app/data" hi-human
```

For a zero-credential walkthrough, override the mode at the command line — no `.env` needed:

```bash
docker run --rm -p 3000:3000 -e DEMO_MODE=true hi-human
```

### With Node directly

```bash
npm install
npm start                           # → http://localhost:3000
```

Then: open a channel on the right rail → type a requirement → **Submit as requirement →**. Watch the session, deploy URL, follow-up, feedback, and PR appear in the channel, then open the **Dashboard**.

### Demo vs live mode

| `DEMO_MODE` | Behaviour |
|---|---|
| `true` | Devin is **simulated end-to-end** on a realistic timeline (deploy ~12s after submit; PR ~6s after feedback; merge shortly after). Nothing external is called, no ACUs spent. |
| `false` | Hits the **real Devin v3 API** (consumes ACUs). Devin builds, deploys, and opens the PR itself; PR status is read back from the Devin session. |

Live mode needs, in `.env` (copy from `.env.example`):
- `DEVIN_API_KEY` — a v3 org-scoped service-user key (`cog_…`). See https://docs.devin.ai/api-reference.
- `DEVIN_ORG_ID` — optional; auto-resolved from `/v3/self` if blank.
- `GITHUB_REPO` — owner/repo of your Superset fork (the prompt points Devin here).

> This service does **not** call the GitHub REST API — issues aren't created and PR state comes from Devin. A `/webhook/github` receiver still exists as an optional external trigger: point a GitHub *Issues* webhook at it (tunnel locally with `smee.io`/`ngrok`); any issue opened with a `sales-member` / `operations-member` / `tech-member` label kicks off the same flow. Set `GITHUB_WEBHOOK_SECRET` to verify signatures.

---

## Observability — "how would I know this is working?"

The **Dashboard** (right rail → 📊) reports, live:
- **Throughput**: total requirements, in-flight/done, merged & done.
- **Velocity**: avg time-to-deploy and avg full cycle time (submit → merge), per requirement.
- **Quality**: average stakeholder score (1–5), overall and per channel.
- **Per-channel breakdown**: who is generating demand and how it lands.
- **PR status**: merged / open / none.
- **Requirement ledger**: every item with status, timing, score, and links to issue, live app, and PR.

Every state transition is also narrated into the originating channel, so the chat itself is an audit trail.

---

## The Superset fork (Part 1 deliverable)

Fork: https://github.com/kifune831-pixel/superset

Create the issues you intend to remediate and label them by channel, e.g.:
- `sales-member` — "Add CSV export button to dashboards"
- `tech-member` — "Upgrade Flask dependency to patch CVE-XXXX"
- `operations-member` — "Add a scheduled-report health check"

In live mode these are created automatically when a requirement is submitted; you can also open them by hand and let the webhook trigger the flow.

---


## Test

`e2e.mjs` drives the whole pipeline against a running server:
```bash
DEMO_MODE=true POLL_INTERVAL_MS=2000 PORT=3055 node server/index.js &
PORT=3055 node e2e.mjs
```
