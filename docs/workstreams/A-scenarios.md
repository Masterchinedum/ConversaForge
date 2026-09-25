# Workstream A — Scenario creator

Covers the scenario library, the editor backend and UI (guided, advanced, YAML/JSON), validation, publishing with immutable versions, rollback, duplicate/import/export, the drafting assistant, built-in templates, and the workspace and public galleries.

## API (`apps/api/src/modules/scenarios`)

All routes live under `/api/workspaces/:workspaceId/scenarios`. Reading drafts and editing require `scenarios.edit` (CREATOR or higher). Publishing and rollback require `scenarios.publish`. Listing a scenario in the gallery requires `scenarios.share`. Routes that API keys may call carry `@ApiScopes('scenarios:read' | 'scenarios:write')`.

| Method & path | Purpose |
|---|---|
| `GET /` | Lists scenarios. Query params: `q` (matches name, public description, slug, tags and internal description), `type`, `status`, `privacy`, `tag`, `isTemplate`, `includeArchived`, `sort=updated\|created\|name`, `limit`, `cursor`. Each row includes `latestVersionNumber`, `draftHasUnpublishedChanges` and `sessionCount`. |
| `POST /` | Creates a scenario. `{source:'blank',name,type?}`, `{source:'template',templateKey,name?}`, `{source:'import',text,format:'yaml'\|'json'\|'auto',name?}` or `{source:'duplicate',scenarioId,versionId?,name?}`. The slug is unique per workspace (`name`, `name-2`, …). |
| `GET /:id` | Returns `{ scenario, draft{config,lockedFields,revision}, latestVersion, draftHasUnpublishedChanges, issues, canPublish, sessionCount }`. |
| `PATCH /:id` | Sets `{ isTemplate }` (workspace templates appear in the workspace gallery). |
| `DELETE /:id` | Soft delete. Versions and sessions are kept. |
| `PATCH /:id/draft` | `{ revision, config?, patch?:[{path,value}], lockedFields? }`. Returns 409 `revision_conflict` (with `details.currentRevision`) if the revision doesn't match. Drafts are validated permissively: incomplete drafts are stored, structurally invalid ones get 422 with field paths. Patch paths are allow-listed, so `__proto__`, `constructor` and unknown roots are rejected. Prose is stored verbatim. `Scenario.name/type/privacy/tags/publicDescription` are kept in sync with the draft. |
| `POST /:id/draft/import` | `{revision,text,format}`. Replaces the draft with imported YAML/JSON. |
| `POST /:id/draft/revert` | `{revision,versionId?}`. Discards draft changes and resets the draft to a version (latest by default). |
| `POST /:id/validate` | Runs `validateScenarioForPublish` plus workspace checks. Accepts an optional `{config}` to validate unsaved text. |
| `POST /:id/publish` | `{changeNote?, revision?}`. See "Publishing" below. |
| `GET /:id/versions`, `GET /:id/versions/:vid` | Version list (number, date, publisher, note, rollback source, session count, `matchesDraft`) and a single version with its config. |
| `GET /:id/diff?from=&to=` | Field-level diff (`diffConfigs`). Refs can be `draft`, `latest` or a version id. |
| `POST /:id/versions/:vid/rollback` | Publishes a new version that copies the old config (`rolledBackFromVersionId` set) and resets the draft to it. Returns 409 `no_changes` if that config is already the latest. |
| `POST /:id/archive`, `/unarchive` | Archived scenarios can't be run or published. |
| `POST /:id/gallery {listed}` | Only allowed when the scenario is PUBLIC and published and the workspace allows public scenarios. |
| `GET /:id/export?format=yaml\|json&source=draft\|version&versionId=` | Download. Each export is audited. |
| `GET /:id/preview?source=draft\|version` | Participant view (sample variables substituted, persona name, first turn, duration, consent and recording summary, visible tools) plus the compiled system prompt. |
| `POST /:id/assistant {instruction}`, `GET /:id/assistant`, `POST /:id/assistant/:pid/apply {paths?}`, `POST /:id/assistant/:pid/reject` | Drafting assistant (see below). |

Gallery routes:
- `GET /api/gallery` (public; rate-limited to 300 requests per 5 minutes per IP) returns templates plus PUBLIC, listed, published scenarios.
- `GET /api/gallery/:scenarioId` returns public detail.
- `GET /api/gallery/templates` and `GET /api/gallery/templates/:key` return the built-in templates.
- `GET /api/workspaces/:ws/gallery` (any member) returns templates, ORGANIZATION/PUBLIC published scenarios, and the workspace's templates (creators only).

Public responses are built field by field from an allowlist: name, type, public description, participant instructions (placeholders filled from defaults or labels), duration, persona name, tags, recording/analysis flags, and workspace display name/logo/color. They never include internal descriptions, AI instructions, persona description or role, rubric, extraction, variables, tools, knowledge or settings. The data comes from the latest published version, never the draft.

### Contracts for other workstreams
- `ScenariosService.getRunnableVersion(workspaceId, scenarioId, versionId?)` returns `{ scenario, version, config }`. It throws 404 for an unknown scenario or version (including ids from another workspace), 409 `scenario_unpublished`, or 409 `scenario_archived`. `ScenariosModule` exports `ScenariosService` and `GalleryService`.
- **Privacy follows the draft.** `Scenario.privacy` mirrors `draft.basics.privacy` immediately; it is not tied to publishing. **E:** change privacy with `PATCH …/draft` and `patch:[{path:'basics.privacy',value}]` so the two stay in sync. When privacy stops being PUBLIC, the scenario is unlisted from the gallery automatically. Setting PUBLIC is rejected (422) when the workspace setting `allowPublicScenarios` is `false`.
- **Run page for E.** The public gallery links "Start" to `/p/<scenarioId>`, which workstream E owns.
- **Additive schema change.** `DraftAssistantProposal` gained `model String?`, `simulated Boolean @default(false)` and `dropped Json @default("[]")`.
- **Publisher attribution.** H's `/api/v1` controllers already call `list/detail/listVersions/getVersion/create/updateDraft/publish`. Versions published with an API key have no `publishedById`, so the UI shows "API".

## Publishing and versions

1. Validation runs `validateScenarioForPublish` plus workspace checks:
   - knowledge document ids and custom function ids must belong to this workspace and not be deleted (FAILED or processing documents and disabled functions only give warnings);
   - tool ids must exist in `TOOL_CATALOG`, must not be `planned` while enabled, and must not be duplicated;
   - PUBLIC privacy is blocked when the workspace disallows it;
   - warnings for knowledge search enabled with no documents, and for `end_session` being disabled.
2. The config is normalized with `normalizeScenarioConfig`, and `configHash` is `sha256(stableStringify(normalized))`.
3. In one transaction the `Scenario` row is locked (`SELECT … FOR UPDATE`), identical config is rejected (409 `no_changes`, "No changes since version N"), the new version number is max+1, and the transaction inserts the `ScenarioVersion`, updates `latestVersionId/Number/status`, and sets the draft's `baseVersionId`. A `revision` in the body guards against publishing a draft other than the one the author reviewed. The action is audit-logged as `scenario.published`.
4. `draftHasUnpublishedChanges` compares the normalized-draft hash with the latest version's hash, so whitespace or disabled tools don't count as changes.
5. Versions are never updated. The DB trigger enforces this, and a test covers it.

## Import and export (`scenario-io.ts`)
YAML and JSON are treated strictly as data:
- a 200 KB cap is checked before parsing;
- YAML is parsed with `YAML.parseDocument(text, { schema:'core', customTags:[], merge:false, uniqueKeys:true, prettyErrors:true, strict:true })`, and any error or warning (including unresolved tags such as `!!js/function` or `!!python/object`) is rejected;
- `toJS({ maxAliasCount: 50 })` stops billion-laughs attacks, and nesting depth is capped at 32;
- `__proto__`, `constructor` and `prototype` keys are stripped;
- the result is validated with zod, and errors report field paths.

Export writes YAML with a comment header, or plain JSON. Import also accepts an envelope of the form `{kind:'conversaforge.scenario', config}`.

## Drafting assistant (`draft-assistant.service.ts`, `rule-drafter.ts`)

**How a proposal is made:**
- The model is resolved with `LlmService.resolve(ws,'assistant')` and called through `completeJson`.
- The JSON schema is `{changes:[{path ∈ allowed EDITABLE_FIELD_PATHS minus locked, valueJson, reason}]}`. `valueJson` is a JSON-encoded string rather than `value`, because Anthropic and OpenAI structured outputs don't accept an "any type" field. The sanitizer also accepts a plain `value`.
- The prompt contains a per-field schema guide, the locked fields, the current draft (marked as author data, not instructions) and the instruction.

**How the output is checked:** each proposed change is dropped, with a reason, if its path is unknown or locked (locks cover parent and child paths), its value isn't valid JSON, or setting it into a copy of the draft fails `ScenarioConfigSchema`. Changes that don't alter anything are skipped. Kept changes are stored as `{path, before, after(parsed), reason}`, together with `simulated`, `provider` and `model`.

**Applying and rejecting:**
- **Apply** takes all changes or selected `paths`. It returns 409 `locked` if a field has been locked since the proposal was made. If the draft revision has moved on, each selected field is checked against its `before` value, and 409 `stale` lists any that no longer match. Otherwise the changes are written with the revision check. The proposal's status becomes `APPLIED` or `PARTIAL`.
- **Reject** sets the status to `REJECTED`.
- **Limits and billing:** proposals are rate-limited to 120 per hour per workspace. With a real provider, the quota is checked first and token usage is recorded.

**Simulator path.** When no provider key is configured, a deterministic, rule-based drafter runs instead. It parses the type, the duration ("15-minute", "half an hour"), the persona from "with a …", the subject from "about …", traits, and "never …" boundaries. It fills only EMPTY fields, or fields the instruction explicitly names (rubric, agenda, opening line, closing, goals, tone, name, description, extraction…). Its proposals are always labeled simulated. Tests confirm that a brief alone produces a publishable draft.

## Templates (`packages/shared/src/templates.ts`)
There are 8 original templates:
- behavioral interview
- system-design interview (whiteboard and timer tools)
- sales discovery with a skeptical CFO
- renewal price negotiation
- delivering difficult feedback
- support de-escalation
- product demo (cards and knowledge_search tools, no rubric)
- active-listening coaching (coach mode and memory)

`templates.test.ts` checks that every template passes publish validation with no agenda or boundary warnings, uses only available tools, uses only allowlisted placeholders, and has no placeholders in public fields. It also checks that the required kinds are covered.

## Web
- `/w/[id]/scenarios` — library table: debounced search, filters (type, status, privacy), status badges (Draft / Published vN / Unpublished changes / Archived), load-more pagination, and New scenario (blank, template, or import YAML/JSON as text or file), Duplicate, Archive/Unarchive and Delete.
- `/w/[id]/scenarios/[scenarioId]` — the editor.
  - **Header:** save state and revision, Validate, Preview, Duplicate, Export YAML/JSON, and Publish (a modal with a change note that is blocked while errors exist). Links go to Share & access (E), Sessions (D) and "Try it", which calls B's `POST …/scenarios/:sid/sessions`, stores the token in session and local storage, and opens `/live/<id>`. "Try it" is disabled until the scenario is published.
  - **Autosave:** changes save 900 ms after the last edit by sending the full config with its revision. If the server reports a revision conflict, a banner offers "Load latest" or "Overwrite with mine". Leaving the page with unsaved changes triggers a warning.
  - **Guided mode:** 7 steps with a per-step error count.
  - **Advanced mode:** every section — basics; persona (voice, avatar); instructions; conversation (strategy, first turn, agenda editor with add/remove/reorder, required flag, fixed question, max follow-ups, ids); turn-taking; timed instructions; ending; model and providers; audio; recording and consent; analysis visibility; rubric (weight total and "Normalize to 100"); extraction; runtime variables; memory; coach; tools (catalog, with planned tools disabled as "Coming soon", usage hint and JSON config); knowledge picker; custom function picker (both handle 404 and 403 gracefully and keep orphan ids); channels; access defaults.
  - **Locks:** a 🔒 toggle sits beside every `EDITABLE_FIELD_PATHS` field.
  - **YAML/JSON mode:** the text is parsed on the client with the same strict YAML options, errors show inline, and Apply saves through the API.
  - **Side panels:** the validation panel combines client-side shared validation with the server's workspace-level issues. Clicking an issue switches to Advanced and scrolls to and focuses the field. The drafting assistant panel shows each proposed change as a before/after diff with accept checkboxes, "Apply selected", "Reject all", a simulated badge, the discarded suggestions and recent proposals.
  - **Versions tab:** list, view config, diff against the draft, the latest version or any other version, and rollback with a confirmation.
  - **Preview tab:** the participant view plus the compiled prompt.
- `/w/[id]/gallery` — workspace scenarios (Start, Duplicate or Use template, Edit) and the starter templates (Use template takes you to the editor).
- `/gallery`, `/gallery/[scenarioId]`, `/gallery/templates/[key]` — public pages. "Start" links to `/p/[scenarioId]` (E). A template page lets a logged-in creator pick a workspace and create from it; logged-out visitors are sent to log in or sign up.

## Tests (actual results)
- `pnpm --filter @cf/shared test`: 48 passed, including 34 template tests.
- `cd apps/api && npx jest src/modules/scenarios`: 37 passed across 3 suites. The integration spec needs a Postgres DB named `conversaforge_test_a` (override with `TEST_DATABASE_URL`) and covers:
  - draft revision conflicts, permissive storage, unsafe paths, prose kept verbatim;
  - publish blocks missing fields, bad weights, unknown placeholders, another workspace's knowledge documents and functions, and planned tools;
  - versions are immutable (the DB trigger rejects UPDATE), an identical republish gets 409, diffs work, rollback creates v3 with the right hash and resets the draft;
  - `getRunnableVersion` handles unpublished, archived and pinned versions;
  - duplicates are isolated, and soft delete works;
  - every operation returns 404 across workspaces;
  - list search, filters and pagination;
  - the assistant never touches locked fields, a brief produces a publishable draft, the sanitizer drops locked, unknown and invalid changes, stale fields give 409 while partial apply works, and fields locked after a proposal give 409;
  - the gallery never leaks private fields or keys, hides private or disallowed scenarios, and the workspace gallery stays within its workspace.
- `scenario-io.spec.ts` covers YAML tags (`!!js/function`, `!!python/object/apply`, custom tags), alias bombs, oversize input, schema errors with paths, duplicate keys, deep nesting, merge keys and `__proto__` pollution.
- Manual `curl` checks against an API on :4101:
  - the full journey (template → publish v1 → 409 on identical republish → revision conflict → v2 → diff → rollback v3 → YAML export → preview with compiled prompt → import round trip → `!!js/function` rejected → assistant propose/apply (simulated) → list in gallery → public gallery and detail with only public fields → workspace gallery);
  - permissions: a user from another workspace gets 404, a MEMBER gets 403 on scenario routes and 200 on the workspace gallery, and a cross-origin cookie POST gets 403.
- Playwright `apps/web/e2e/scenarios.spec.ts` passed in 23 s against web :3101 and API :4101. The journey is: create blank → lock the name → simulated assistant proposal without the name → apply → edit with autosave → break the rubric weights, see the error, normalize → Validate → publish v1 → edit → v2 → diff → rollback to v1 (creates v3) → preview (participant view and prompt) → YAML with an invalid value shown inline, then a valid one applied → library badges → workspace gallery "Use template" → public gallery. Command: `WEB_URL=http://localhost:3101 CHROMIUM_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell npx playwright test e2e/scenarios.spec.ts` (the installed Chromium is build 1194, Playwright expects 1193, so `CHROMIUM_PATH` overrides it).

## Not done / notes for the lead
- **Real AI provider untested.** The drafting assistant's real-provider path (Anthropic/OpenAI `completeJson` with the JSON schema) is implemented but not tested here, because no keys are available. Only the simulator path was exercised.
- **Prompt preview depends on B.** It imports B's `compileStablePrompt` and `compileDynamicPrompt` from `modules/runtime/engine/prompt-compiler.ts` (and `initialRuntimeState`) and passes `hasUpdateProgressTool: true`. If B changes those signatures, the only file to update is `scenario-preview.ts`. If the compiler throws, the preview returns `prompt: null` with a note.
- **Custom functions list is admin-only.** G's `GET /workspaces/:ws/functions` requires `providers.manage` (ADMIN), so creators see "ask an admin" in the functions picker; ids already on the scenario are kept and still validated server-side. Relaxing it to CREATOR read access would be G's change to make.
- **Shared `tsconfig.json` edited by dev servers.** `next dev` rewrote `apps/web/tsconfig.json` to add `.next-a/types/**` (other workstreams' dev servers added theirs too). The lead may want to reset that file before committing.
