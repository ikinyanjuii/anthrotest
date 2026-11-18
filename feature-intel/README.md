# Feature Intelligence System

An AI triage agent for product feature requests. Each submission is embedded and matched against existing requests, judged by Claude (duplicate / related / distinct), reframed into the underlying customer need, assigned to a theme and route, and scored against configurable business criteria. Weighted priority is computed in code, separate from vote popularity.

Humans stay in control: AI suggests merges, PMs confirm; status changes are human; outbound updates are drafts only.

## Requirements

- Node.js 22+
- npm
- Anthropic API key for live Claude triage, decision briefs and requester-update drafts
- Optional Voyage API key for hosted semantic embeddings; a deterministic local similarity index works without it

## Setup

```bash
cd feature-intel
npm install
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env for live AI functionality
npm run typecheck
npm run smoke
npm run dev
```

Open http://localhost:3000. The API and static web application are served by the same Express process. Without an Anthropic key, the server and offline smoke checks work, but live AI triage and generated briefs cannot run.

## Demo data and evaluation

```bash
npm run seed
npm run eval
npm run eval -- --repeat=3
```

The evaluation harness uses an in-memory database and labelled cases in `scripts/eval-data.json`. It reports duplicate precision/recall, false-merge rate, three-way classification accuracy, retrieval recall@5 and prompt-injection resistance. The live LLM evaluation requires `ANTHROPIC_API_KEY`.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/requests` | Submit a request; triage runs asynchronously |
| GET | `/api/requests?sort=priority|votes&theme=&status=` | Discover requests |
| GET | `/api/requests/:id` | Details, scores, rationale and duplicate suggestion |
| POST | `/api/requests/:id/vote` | Support a request |
| POST | `/api/requests/:id/merge` | Human-confirmed merge |
| POST | `/api/requests/:id/dismiss-duplicate` | Keep a suggested duplicate separate |
| POST | `/api/requests/:id/status` | Set planned / shipped / declined |
| POST | `/api/requests/:id/draft-update` | Draft a requester update for human approval |
| GET | `/api/themes` | Themes with volume and emerging indicator |
| POST | `/api/themes/:id/brief` | Generate a decision brief |
| GET/PUT | `/api/criteria` | View / tune scoring weights |

## Design

- Retrieve then reason: semantic candidates are found first; Claude judges whether the customer need and scope are actually the same.
- Structured model output is validated with Zod, with one repair attempt.
- Priority is calculated deterministically from configured weighted criteria, not by the LLM or vote count.
- User text is escaped and delimited as data in prompts; a prompt-injection test case is included.
- Full validated triage output and errors are stored for auditability.
- Human confirmation is required for merges and outbound updates.

## Configuration

See `.env.example`:

- `ANTHROPIC_API_KEY` — required for Claude features; keep it only in local `.env` or managed deployment secrets.
- `ANTHROPIC_MODEL` — defaults to `claude-sonnet-5-5`.
- `VOYAGE_API_KEY` / `VOYAGE_MODEL` — optional embeddings.
- `PORT` — defaults to 3000.
- `DB_PATH` — defaults to `data.db`.

## Security and known limitations

This is an assessment MVP, not a production-ready multi-user service. It currently has **no authentication or authorization**. Voter identity is supplied by the client and is not verified. Do not expose it publicly or use real customer data until authentication, authorization, rate limiting, audit access controls, secure deployment secrets, backups, monitoring and privacy controls are added. The in-process triage queue is not durable across restarts. SQLite with JSON vectors is intended for a small demo; move to PostgreSQL/pgvector for larger workloads.

## Assessment assets

- `scripts/seed.ts` — deliberately messy sample data, including an injection attempt.
- `scripts/eval-data.json` — labelled retrieval and triage cases.
- `scripts/smoke.ts` — offline checks for retrieval, scoring, merges and vote roll-up.
- `CLAUDE.md` / `prompts.txt` — project prompt-logging instructions and history.
