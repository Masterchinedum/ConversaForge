# ConversaForge

AI voice-agent platform for structured conversations — interviews, coaching, sales practice, negotiation, leadership conversations, demos and support. Creators author scenarios; participants talk to the agent by voice in the browser (phone and meeting channels via adapters); reviewers get transcript-grounded, rubric-based feedback and structured extracted data; admins control members, access, usage and branding; developers integrate through a versioned REST API, webhooks and an embeddable widget.

- **Status of every feature** (complete vs. placeholder vs. needs credentials): [`docs/STATUS.md`](docs/STATUS.md)
- Architecture & conventions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- REST API & webhooks: [`docs/api.md`](docs/api.md) (Swagger UI at `/api/docs`)
- Embeddable widget: [`docs/embed.md`](docs/embed.md)
- Deployment, monitoring, backups, rollback: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

## Quick start (local)

Prerequisites: Node 22+, pnpm 10 (`corepack enable`), PostgreSQL 16 and Redis/Valkey (or Docker).

The backend and frontend are independent projects (each with its own `package.json`, lockfile, `.env`, Dockerfile and CI workflow). Run each from its own folder:

```bash
# Backend — terminal 1
cd backend
docker compose up -d                          # Postgres :5432 + Valkey :6379 (or use local services)
pnpm install
cp .env.example .env                          # set ENCRYPTION_KEY (openssl rand -hex 32) and SIGNING_SECRET
pnpm prisma:migrate                           # or during development: pnpm db:sync
pnpm seed                                     # optional demo org, users, published templates, course, share link
pnpm dev                                      # http://localhost:4000  (Swagger: /api/docs)

# Frontend — terminal 2
cd frontend
pnpm install
cp .env.example .env.local                    # points at the backend on :4000
pnpm dev                                      # http://localhost:3000
```

Demo users (after seeding; password `demo-password-123`): `owner@demo.test`, `admin@demo.test`, `creator@demo.test`, `reviewer@demo.test`, `learner@demo.test`.

### AI providers and cost control
No provider key is required to try the product: without one, conversations, analysis and the drafting assistant run on a **local simulator** that is clearly labeled everywhere ("Simulated"). For real conversations add **one** of:

- `OPENAI_API_KEY` — live speech-to-speech voice (**OpenAI Realtime**), server TTS/STT, and a text model for analysis/drafting.
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`; a Gemini Developer API key from aistudio.google.com) — live speech-to-speech voice (**Google Gemini Live**) and a text model for analysis, drafting and coach memory. A Google key alone gives a fully working product.
- `ANTHROPIC_API_KEY` (Claude) — text model for pipeline conversations, analysis and drafting. Voice then uses the browser's speech recognition/synthesis (Chrome/Edge).

**Voice modes.** New scenarios default to **live speech-to-speech** (Model → Voice mode "Live", provider "Auto" = Google Gemini Live `gemini-3.8-live`, with OpenAI `gpt-realtime-2.1` as the backup if Gemini has no key or fails during the call). The browser talks to the live model directly with a short-lived, single-use credential minted by the API — the real key never reaches the browser and the instructions/tools are locked into that credential. Browser speech is the last resort: when neither live model is available (or on phone calls and meeting notetakers) sessions automatically fall back to the **pipeline** (speech-to-text → language model → text-to-speech) and the call screen says so. Pipeline mode stays selectable per scenario when you want server-side control and auditability of every reply. Text models (Anthropic → OpenAI → Google fallback order, or the scenario's choice) are still used for post-session scoring/extraction, the drafting assistant and coach memory. Models: `OPENAI_REALTIME_MODEL`, `GEMINI_LIVE_MODEL`, `GEMINI_TEXT_MODEL`, `GEMINI_ANALYSIS_MODEL`, `ANTHROPIC_LIVE_MODEL`, … (see `.env.example`).

Keys can be set on the server (`backend/.env`) or per workspace in **Settings → AI providers** (encrypted at rest). To cap spend: set workspace quotas (Settings → Usage & quotas: session minutes / estimated cost per month with hard limits), keep `DEFAULT_MAX_SESSION_MINUTES` low, and use a cheaper model via `ANTHROPIC_LIVE_MODEL=claude-haiku-4-5` / `ANTHROPIC_ANALYSIS_MODEL=claude-sonnet-5` / `GEMINI_ANALYSIS_MODEL=gemini-2.5-flash`. Every provider call is recorded in the usage ledger with an estimated cost.

## Repository layout

```
backend/        NestJS 11 + Fastify API, WebSocket runtime, BullMQ worker, Prisma schema — standalone project
frontend/       Next.js 15 web app (creator/reviewer/admin UI, live call page, embed) — standalone project
infra/          Production compose + Caddy (runs the two published images together), backup/restore scripts
docs/           Architecture, API, embed, deployment, status, workstream notes
```

Neither project imports from the other. The API ↔ web contract (scenario schema & validation, scoring math, variables, state machine, WebSocket protocol, roles) lives in `src/shared/` and **each project keeps its own copy**. Change both copies together; `pnpm check-shared-drift` (in either folder, also run in CI) diffs them. To split into two repositories, move `backend/` or `frontend/` out as-is, together with its workflow from `.github/workflows/`.

## Scripts

Run in `backend/` or `frontend/`:

| Command | Where | What it does |
|---|---|---|
| `pnpm build` | both | Build the project |
| `pnpm typecheck` | both | Type-check the project |
| `pnpm test` | backend | Unit/integration tests (jest, including `src/shared`) |
| `pnpm e2e` | frontend | Playwright browser journeys (needs API + web running) |
| `pnpm db:sync` | backend | Dev schema sync (db push + raw SQL objects) |
| `pnpm worker` | backend | Run the job worker as a separate process |
| `pnpm check-shared-drift` | both | Diff this project's `src/shared` against the other's |

## License
Proprietary. All third-party dependencies are under permissive licenses (MIT, Apache-2.0, BSD, ISC); see `docs/THIRD_PARTY.md`.
