# ConversaForge

AI voice-agent platform for structured conversations — interviews, coaching, sales practice, negotiation, leadership conversations, demos and support. Creators author scenarios; participants talk to the agent by voice in the browser (phone and meeting channels via adapters); reviewers get transcript-grounded, rubric-based feedback and structured extracted data; admins control members, access, usage and branding; developers integrate through a versioned REST API, webhooks and an embeddable widget.

- **Status of every feature** (complete vs. placeholder vs. needs credentials): [`docs/STATUS.md`](docs/STATUS.md)
- Architecture & conventions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- REST API & webhooks: [`docs/api.md`](docs/api.md) (Swagger UI at `/api/docs`)
- Embeddable widget: [`docs/embed.md`](docs/embed.md)
- Deployment, monitoring, backups, rollback: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

## Quick start (local)

Prerequisites: Node 22+, pnpm 10 (`corepack enable`), PostgreSQL 16 and Redis/Valkey (or Docker).

```bash
docker compose up -d                          # Postgres :5432 + Valkey :6379 (or use local services)
pnpm install
cp .env.example apps/api/.env                 # set ENCRYPTION_KEY (openssl rand -hex 32) and SIGNING_SECRET
cp apps/web/.env.local.example apps/web/.env.local 2>/dev/null || printf "API_INTERNAL_URL=http://localhost:4000\nNEXT_PUBLIC_API_WS_URL=ws://localhost:4000\n" > apps/web/.env.local
pnpm --filter @cf/shared build
pnpm --filter @cf/api prisma:migrate           # or during development: (cd apps/api && pnpm db:sync)
pnpm --filter @cf/api seed                     # optional demo org, users, published templates, course, share link
pnpm dev:api                                   # http://localhost:4000  (Swagger: /api/docs)
pnpm dev:web                                   # http://localhost:3000
```

Demo users (after seeding; password `demo-password-123`): `owner@demo.test`, `admin@demo.test`, `creator@demo.test`, `reviewer@demo.test`, `learner@demo.test`.

### AI providers and cost control
No provider key is required to try the product: without one, conversations, analysis and the drafting assistant run on a **local simulator** that is clearly labeled everywhere ("Simulated"). For real conversations add **one** of:

- `ANTHROPIC_API_KEY` (Claude) — language model for live turns, analysis and drafting. Voice uses the browser's speech recognition/synthesis (Chrome/Edge), so this is the only paid component.
- `OPENAI_API_KEY` — optional: OpenAI Realtime speech-to-speech, server-side TTS/STT, or as the language model.

Keys can be set on the server (`apps/api/.env`) or per workspace in **Settings → AI providers** (encrypted at rest). To cap spend: set workspace quotas (Settings → Usage & quotas: session minutes / estimated cost per month with hard limits), keep `DEFAULT_MAX_SESSION_MINUTES` low, and use a cheaper model via `ANTHROPIC_LIVE_MODEL=claude-haiku-4-5` / `ANTHROPIC_ANALYSIS_MODEL=claude-sonnet-5`. Every provider call is recorded in the usage ledger with an estimated cost.

## Repository layout

```
apps/api        NestJS 11 + Fastify API, WebSocket runtime, BullMQ worker, Prisma schema
apps/web        Next.js 15 web app (creator/reviewer/admin UI, live call page, embed)
packages/shared Scenario schema & validation, scoring math, variables, state machine, protocol
infra           Dockerfiles, production compose, Caddy, backup/restore scripts
docs            Architecture, API, embed, deployment, status, workstream notes
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm build` | Build shared, API and web |
| `pnpm test` | Unit/integration tests (shared: vitest, API: jest) |
| `pnpm typecheck` | Type-check all packages |
| `pnpm --filter @cf/web e2e` | Playwright browser journeys (needs API + web running) |
| `cd apps/api && pnpm db:sync` | Dev schema sync (db push + raw SQL objects) |
| `pnpm --filter @cf/api worker` | Run the job worker as a separate process |

## License
Proprietary. All third-party dependencies are under permissive licenses (MIT, Apache-2.0, BSD, ISC); see `docs/THIRD_PARTY.md`.
