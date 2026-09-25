# Deployment, operations, monitoring & rollback

ConversaForge runs as four processes: **web** (Next.js), **api** (NestJS/Fastify, HTTP + WebSocket), **worker** (BullMQ jobs: analysis pipeline, knowledge ingestion, webhooks, channels, maintenance), plus **PostgreSQL 16** and **Redis-compatible** storage (Valkey). Media goes to local disk (single host) or any S3-compatible bucket (recommended).

## 1. Single-host production (Docker Compose)

Requirements: a Linux host with Docker, a DNS record `APP_DOMAIN` pointing at it, ports 80/443 open.

```bash
git clone <repo> conversaforge && cd conversaforge
# Build images (or pull from your registry in CI)
docker build -f infra/docker/api.Dockerfile -t conversaforge/api:1.0.0 .
docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_WS_URL=wss://app.example.com -t conversaforge/web:1.0.0 .

cd infra
cp ../.env.example .env.production     # then edit — see "Required settings" below
export APP_DOMAIN=app.example.com POSTGRES_PASSWORD=<strong> VERSION=1.0.0
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate   # prisma migrate deploy
docker compose -f docker-compose.prod.yml up -d
curl https://app.example.com/health
```

Required settings in `.env.production`:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `API_PUBLIC_URL`, `WEB_PUBLIC_URL` | `https://app.example.com` (same origin behind Caddy) |
| `NEXT_PUBLIC_API_WS_URL` | `wss://app.example.com` (baked into the web image at build time) |
| `DATABASE_URL` | `postgresql://conversaforge:<pw>@postgres:5432/conversaforge` |
| `REDIS_URL` | `redis://redis:6379` |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` — **back it up**; losing it makes stored provider keys/webhook secrets unreadable |
| `SIGNING_SECRET` | `openssl rand -base64 48` |
| `COOKIE_SECURE` | `true` |
| `ALLOW_SIMULATOR` | `false` (never serve simulated conversations to real users) |
| `STORAGE_DRIVER` | `s3` recommended (`S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` for R2/MinIO, keys) |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | at least one, or configure per workspace in Settings → AI providers |
| `SMTP_URL`, `MAIL_FROM` | for invitations, password resets and notifications |

Caddy (`infra/Caddyfile`) terminates TLS automatically, routes `/api/*`, `/health` and `/ws/*` to the API and everything else to the web app.

### Scaling notes
- **WebSockets & live sessions**: each live conversation's engine lives in the API process that holds the participant's WebSocket. With several API replicas, use sticky routing on `/ws/session` (e.g. hash on the `sessionId`) — reconnects to a different replica work (engines rebuild state from the database), but an in-flight agent turn is regenerated.
- **Workers** scale horizontally (`docker compose up -d --scale worker=3`); every job uses deterministic ids and idempotent writes.
- Set `RUN_WORKERS_IN_API=false` on API containers in production so HTTP latency isn't affected by jobs.

## 2. Managed platforms
Any container platform works (Fly.io, Render, ECS, Kubernetes): run the same `api` image twice (`api` and `worker` commands), the `web` image, managed Postgres 16 (e.g. RDS, Neon, Supabase) and managed Redis/Valkey (ElastiCache/Upstash; BullMQ needs `maxmemory-policy noeviction`). Run `migrate` as a release/pre-deploy job.

## 3. Database migrations
- Migrations live in `apps/api/prisma/migrations` and are applied with `prisma migrate deploy` (the `migrate` command of the API image). The initial migration also installs the ScenarioVersion immutability trigger and the knowledge full-text-search column (`prisma/sql/post-push.sql`).
- Develop schema changes with `pnpm --filter @cf/api prisma:dev --name <change>`; review the SQL; ship backward-compatible migrations (expand → deploy → contract) so the previous release keeps working during a rollout.

## 4. Monitoring
- **Health**: `GET /health` returns `{ status, db, redis, latencyMs, version }` (HTTP 200 always; alert when `status != "ok"`). Point an uptime monitor at it every minute.
- **Logs**: API/worker log to stdout (Nest logger; every HTTP error includes a `requestId` that is also returned to the client in the error envelope and the `X-Request-Id` header). Ship container logs to your log platform (Loki, CloudWatch, Datadog…). Alert on `ERROR` rate and on `Job … failed` lines from the worker.
- **Queues**: BullMQ state is in Redis; alert when `session-pipeline` failed jobs grow. Sessions whose analysis failed are visible in the app (Sessions → Processing tab) with a Retry button; the maintenance job re-enqueues stuck pipelines.
- **Usage/cost**: Settings → Usage & quotas shows the ledger; set quotas and alert thresholds per workspace. Admins get in-app/email alerts when thresholds are crossed.
- **Webhooks**: Settings → API & webhooks shows every delivery attempt; subscriptions auto-disable after repeated failures.

## 5. Backups & recovery
- `infra/scripts/backup.sh` — nightly `pg_dump` (custom format) + local media tarball, 14-day retention. Schedule with cron: `15 2 * * * /opt/conversaforge/infra/scripts/backup.sh /var/backups/conversaforge`. Copy backups off-host (e.g. `rclone` to object storage).
- With S3 storage, enable bucket versioning and lifecycle rules instead of tarballs.
- Managed Postgres: enable point-in-time recovery.
- **Restore drill** (do it before launch and quarterly): `infra/scripts/restore.sh backups/db-<ts>.dump` on a staging host, then log in and open a recent session report.
- Keep `ENCRYPTION_KEY` and `SIGNING_SECRET` in a secrets manager; they are required to read restored provider keys and to validate existing signed links.

## 6. Releases & rollback
1. CI (`.github/workflows/ci.yml`) type-checks, builds, and tests every push, and builds both Docker images.
2. Tag images with the git SHA/semver; deploy by setting `VERSION` and running `migrate` then `up -d`.
3. **Rollback**: `VERSION=<previous> docker compose -f docker-compose.prod.yml up -d` (web/api/worker). Because migrations are backward compatible (expand/contract), the previous version runs against the newer schema. If a migration itself must be reverted, restore the pre-deploy backup (take one before every migration: `backup.sh`).
4. Content rollback inside the product is separate: scenario "Rollback" publishes a copy of an older version as a new version; past sessions keep their exact version snapshot.

## 7. Security checklist for launch
- HTTPS only (`COOKIE_SECURE=true`), HSTS via Caddy.
- `ALLOW_SIMULATOR=false`.
- Strong `ENCRYPTION_KEY`/`SIGNING_SECRET`, rotated credentials for DB/Redis, Redis not exposed publicly.
- S3 bucket private (no public ACLs); media is only served through short-lived signed URLs.
- Configure SMTP with SPF/DKIM for your sending domain.
- Review provider data-processing terms (Anthropic/OpenAI/Deepgram/ElevenLabs/Twilio/Recall) and your consent notice text; browser speech recognition (Chrome) sends audio to the browser vendor's speech service — the consent screen discloses this.
- Hiring use: keep "Require human review" on for interview scenarios; scores are advisory.
