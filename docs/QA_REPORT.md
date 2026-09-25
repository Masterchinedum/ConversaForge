# QA report — pre-launch end-to-end pass

Date: 2026-09-25 · Scope: every role (owner, admin, creator, reviewer, member/learner, anonymous participant, API client) driven end to end in a real browser (Playwright + Chromium, fake mic/camera, typed turns because headless Chromium has no speech recognition) against a real API (NestJS, Postgres, Redis/BullMQ workers in-process). No AI keys exist in this environment, so every conversation, analysis and drafting result comes from the clearly labeled simulator.

Everything below is automated in **`apps/web/e2e/journeys.spec.ts`** (14 tests; screenshots of every step go to `$QA_SHOTS`). Final run on a freshly created and seeded database: **14 passed (8.6 min)**.

## Journeys

| # | Journey | Result | What is covered |
|---|---|---|---|
| 1 | Creator | **Pass** | UI sign-up → personal workspace → "+ New organization…" → scenario from template (publish v1) → blank scenario opens in **guided mode** → drafting assistant proposal (simulated) → apply → walk all 7 guided steps → weights ≠ 100 blocks publishing (disabled Publish + inline error) → Normalize → server Validate → publish v1 → edit → v2 → version diff → rollback (creates v3) → Preview → YAML export → import as a new scenario → Duplicate → "Try it" → typed conversation → end screen |
| 2 | Sharing | **Pass** | Participant report visibility set (feedback on, scores/transcript off) → publish v2 → one-time link with passcode, name+email identity, prefilled `role_title` → anonymous context: wrong passcode message → consent → device check → call; prefilled variable reaches the agent; a vague answer triggers a follow-up; agent closes the call → end screen → `/report/<id>` shows only feedback (no scores, no transcript) → reusing the one-time link shows "This link has already been used" → scenario made Public, **listed in the gallery** (new UI, see B1) → anonymous `/gallery` search → Start → `/p/<id>` (missing identity gives inline errors) → call |
| 3 | Reviewer | **Pass** | Sessions list + filters (scenario, state, participant; empty state) → detail: weighted score, evidence links jump to and highlight the transcript turn, recording player, extracted data, processing tab → **Reprocess all** (run 2) → PDF (`%PDF`) and transcript CSV downloads → human-review sign-off; a second short/vague session shows "Not enough evidence to score"; reviewer sees no admin-only Delete |
| 4 | Admin | **Pass** | Invite (link taken from the API's dev-mail log) → invitee signs up from the invite page and accepts → lands in the workspace as creator → admin changes role to reviewer → team created → branding (logo upload, primary color, support email) reflected on `/r/<token>` and `/live` → owner sets a hard quota of 1 session → share-link start blocked with "usage limit reached" and member self-run blocked with a clear toast → quota removed (admins see "Only owners can change quotas") → audit log shows invitation/branding/quota entries → privacy export and delete both reach *completed* → API key created → webhook to a local receiver on :4299 → **Send test** delivers a signed (`t=…,v1=…`) request → AI providers page shows the simulator warning → Phone & meetings shows explicit "Not configured" states |
| 5 | Learner | **Pass** | My learning → enroll in "Interview readiness" (0%) → **Play all** → scenario item via `/live` → "Back to course" → 33% → Play All opens the link item → Mark as viewed → **67%** → Start over → 0%. Coach memory: memory-enabled coaching scenario → facts appear under My memory (labeled simulated) → turn memory off → Clear all |
| 6 | Knowledge | **Pass** | Upload a generated PDF and a .txt → both reach Ready → search tester returns the PDF passage with page citation → attach the PDF to a scenario → publish → document shows "Used by 1 scenario" |
| 7 | Developer | **Pass** | `/api/v1/scenarios`, `/api/v1/sessions` with a `cf_live_` key → `POST /api/v1/sessions` twice with the same `Idempotency-Key` returns the same session with `Idempotency-Replayed: true`; same key + different body → 422; no key → 401 → the returned participant `url` opens `/live` with the variable applied → `/api/docs` (Swagger) and `/docs/api` load |
| 8 | Cross-cutting | **Pass** | Every sidebar page (20) for each of the 5 roles: no console errors/5xx, disallowed pages show a clear "no access" message, unknown workspace → "Workspace not found". 375 px: `/r/<token>`, `/live` (intro, consent, device check, call, end), `/report`, and dashboard/scenarios/sessions/learn/members/usage have no horizontal scroll. Isolation: another workspace's scenario/session ids → API 404 and UI "not found" |

## Bugs found and fixed

| # | Severity | Bug | Fix |
|---|---|---|---|
| B1 | High (dead end) | No UI could list a scenario in the public gallery: `POST /scenarios/:id/gallery` existed but nothing called it; the access page said listing was edited "in the scenario editor", where no such control exists. | Added a **List in public gallery / Remove from gallery** toggle on Share & access → Public visibility; corrected the text (privacy applies when the draft is saved). `apps/web/src/app/w/[workspaceId]/scenarios/[scenarioId]/access/page.tsx` |
| B2 | High | After **accepting an invitation** the app navigated with a stale cached `/auth/me`, so the new member intermittently saw "Workspace not found". | Invite page revalidates `/auth/me` before navigating; the workspace layout re-checks membership once before showing "not found" (also covers other just-joined/created workspaces). `apps/web/src/app/invite/[token]/page.tsx`, `apps/web/src/app/w/[workspaceId]/layout.tsx` |
| B3 | High (mobile) | Most workspace pages were 650–820 px wide on a 375 px phone: the `sr-only` table header span (absolute) escaped the table's scroll box; charts rendered a fixed 600 px SVG that never shrank; Cards in grids could not shrink below their table. | UI kit: `Table` wrapper is `relative`, `Card` is `min-w-0`; line charts use a fluid SVG with a matching viewBox. `apps/web/src/components/ui/index.tsx`, `apps/web/src/components/analytics/charts.tsx` |
| B4 | Medium | UI kit class conflicts: `Select`/`Input` ignored callers' widths (`w-full` beat `w-44`, so filter bars stacked full-width selects), and `Td className="whitespace-normal"` never took effect (22 cells: long text like the privacy "Result" column overflowed). | Kit drops its default `w-full` / `whitespace-nowrap` when the caller passes its own. `apps/web/src/components/ui/index.tsx` |
| B5 | Medium | Participant landing pages (`/r/<token>`, invites, embed info) showed raw `{{product_name}}` placeholders in the description/instructions. | `publicScenarioInfo` fills known values (defaults + link/token variables) and shows the variable label for unknown ones. `apps/api/src/modules/access/access.util.ts`, `public-run.service.ts`, `access.service.ts` |
| B6 | Medium | Share & access tab counters ("Share links (0)") did not update after creating/revoking links, grants or tokens. | Tabs also revalidate the access summary. `apps/web/src/components/access/{ShareLinksTab,GrantsTab,AccessTokensTab}.tsx` |
| B7 | Medium | Keyless demo: the analysis simulator only matched literal rubric words, so realistic answers were almost always "insufficient evidence" (analytics: 0 of 14 scored); first-person signal was case-sensitive ("My task" ignored). | Simulator also recognises metrics / ownership / structure signals (still quoting only real participant text; unrelated criteria stay insufficient; still labeled simulated); case-insensitive first-person and spelled-out numbers. `apps/api/src/modules/analysis/simulator.ts` |
| B8 | Low | Course progress floored (2 of 3 → 66%). | Rounded, capped at 99% until complete (67%). `apps/api/src/modules/courses/course-rules.ts` (+ spec) |
| B9 | Low | Drafting assistant wrote "Practice a 10-minute -minute sales discovery call" for briefs like "a 10-minute sales call". | Phrase regex no longer starts inside "10-minute". `apps/api/src/modules/scenarios/rule-drafter.ts` (+ spec) |
| B10 | Low | Scenario editor 404 was a dead end ("Scenario not found · Retry"). | Not-found state with "Back to scenarios". `apps/web/src/app/w/[workspaceId]/scenarios/[scenarioId]/page.tsx` |
| B11 | Low | Reviewer transcript cluttered by an `update_progress` invoked/result pair after every agent turn. | Hidden by default with a "Show agent progress events (n)" toggle. `apps/web/src/components/review/tabs.tsx` |
| B12 | Low | Reviewers can open Courses (API and page support a read-only view) but the sidebar hid it. | Nav item uses `sessions.review`. `apps/web/src/app/w/[workspaceId]/layout.tsx` |
| B13 | Low | Session list at 1280 px cut off the Date column; scenario library cut off "Delete". | Wrapping cells/actions. `apps/web/src/app/w/[workspaceId]/sessions/page.tsx`, `scenarios/page.tsx` |
| B14 | Low (copy) | Simulator agent said "Great. Let's start. Next, let's cover: …"; simulated next steps read "aim for — Clear STAR…". | "First, let's cover…"; "What good looks like: …". `apps/api/src/modules/runtime/engine/simulator-agent.ts`, `analysis/simulator.ts` |

Verified along the way (no change needed): the post-session pipeline's startup sweep re-queued sessions whose jobs had been consumed by another process (see R1), and every recovered session completed.

## Known remaining issues (prioritized)

1. **R1 — Shared Redis logical DB between processes loses jobs (ops).** During this pass a second API (the security reviewer's, on another Postgres DB) used the same Redis DB 9 and consumed this API's pipeline jobs ("Session … not found"); sessions sat in QUEUED until the 10-minute/startup sweep. In production each environment must have its own Redis DB/instance; consider prefixing BullMQ queue names with an environment key. QA moved to Redis DB 12.
2. **R2 — Simulator scoring is still a heuristic.** Clearly labeled everywhere, but scores are keyword/signal based; configure a provider for any real assessment. Memory facts from the simulator are generic ("Practiced …").
3. **R3 — Not verifiable here:** real speech recognition/synthesis, OpenAI Realtime, Twilio/Recall channels, SMTP delivery, S3 storage, and real LLM output quality (no keys/network). Covered only through simulator/typed paths and "Not configured" states.
4. **R4 — Minor UX:** after Play All finishes a scenario, the participant must click "Back to course" on the end screen (no auto-return); the knowledge upload list keeps "Uploaded" badges after processing (the table shows Ready); demo seed share link identity/variables are basic.
5. **R5 — Dev tooling:** `next dev`/`next build` rewrite `apps/web/tsconfig.json` (`include`) and `next-env.d.ts` with their dist dir; restored after this pass, but anyone running with `NEXT_DIST_DIR` should reset them before committing.

## Commands to re-run

```bash
# 1. Database (fresh) — from apps/api
su postgres -c "dropdb --if-exists conversaforge_qa; createdb conversaforge_qa"
DB=postgresql://postgres:postgres@localhost:5432/conversaforge_qa
DATABASE_URL=$DB npx prisma db push --skip-generate && psql $DB -f prisma/sql/post-push.sql && DATABASE_URL=$DB npx tsx prisma/seed.ts

# 2. API on :4202 (own Redis DB; log file is read by journey 4 to get the invite link)
npx tsc -p tsconfig.build.json --outDir .dist-qa
DATABASE_URL=$DB REDIS_URL=redis://localhost:6379/12 PORT=4202 API_PUBLIC_URL=http://localhost:4202 \
  WEB_PUBLIC_URL=http://localhost:3202 RUN_WORKERS_IN_API=true node .dist-qa/main.js > /tmp/qa-api.log 2>&1 &

# 3. Web on :3202 — from apps/web
NEXT_DIST_DIR=.next-qa WEB_PORT=3202 API_INTERNAL_URL=http://localhost:4202 NEXT_PUBLIC_API_WS_URL=ws://localhost:4202 pnpm dev &

# 4. Journeys — from apps/web (single journey: add -g "4. admin")
E2E_WEB_URL=http://localhost:3202 E2E_API_URL=http://localhost:4202 \
E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_qa \
QA_API_LOG=/tmp/qa-api.log QA_SHOTS=/tmp/qa-shots PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
npx playwright test e2e/journeys.spec.ts
```

Notes: login is rate limited, so cookies are cached in `apps/web/node_modules/.cache/cf-e2e/qa-*.json`; state shared between journeys (the org created in journey 1, API key from journey 4) is persisted in `qa-shared.json` there, so a single journey can be re-run after a full run. Journeys 1, 2, 4 and 7 create uniquely named data each run; journey 5 resets the course (Start over) if needed.

Other gates (all green at the end of this pass): `cd apps/api && npx tsc -p tsconfig.json --noEmit`; `cd apps/web && npx tsc --noEmit`; `cd apps/web && NEXT_DIST_DIR=.next-qa-build npx next build`; API jest **26 suites / 355 tests** (`CF_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_test_qa CF_TEST_REDIS_URL=redis://localhost:6379/13 npx jest --forceExit` after creating that DB with `prisma db push` + `post-push.sql`, to avoid sharing `conversaforge_test` with concurrent runs).
