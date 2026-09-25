# Workstream G: Knowledge base, AI provider connections, custom functions

## What was built

### Knowledge base (`apps/api/src/modules/knowledge`)
All routes are under `/api/workspaces/:workspaceId/knowledge` and require `knowledge.manage` (CREATOR+).

| Method | Path | Purpose |
|---|---|---|
| GET | `/documents?limit&cursor&q&status` | List documents with status, sizes, chunk counts and `referencedBy` (scenarios whose latest published version and/or draft list the doc in `config.knowledge.documentIds`) |
| POST | `/documents` | Multipart upload (`file` plus optional `title` field). A JSON body `{ title, text, format? }` is also accepted |
| POST | `/documents/text` | Paste text: `{ title, text, format: 'text' \| 'markdown' }` |
| GET | `/documents/:id` | Details |
| GET | `/documents/:id/chunks?offset&limit` | Paginated chunk preview |
| PATCH | `/documents/:id` | Rename `{ title }` |
| DELETE | `/documents/:id` | Soft-deletes the document, hard-deletes its chunks and storage object, and marks the MediaAsset DELETED. Returns `referencedBy` so callers can warn |
| POST | `/documents/:id/reprocess` | Re-queue ingestion (202) |
| GET | `/documents/:id/download` | Short-lived (5 min) signed URL for the original file |
| POST | `/search` `{ query, documentIds?, topK? }` | Search tester. Returns ranked results with `citation` plus `modelContext`, the exact text a model receives |

**Upload validation.** The file type comes from magic bytes; the client mime type is never trusted:
- `%PDF-` → PDF
- `PK\x03\x04` with a `word/document.xml` entry → DOCX. Other ZIPs are rejected, and so are ZIPs whose declared uncompressed size exceeds 200 MB (zip-bomb guard).
- Anything else must be valid UTF-8 with no NUL bytes → txt, md or csv (the name or declared type only picks between these three).

Size is capped at `UPLOAD_LIMITS.knowledgeDocument` (25 MB), and oversize uploads return 413. File names are sanitized (no paths, control or bidi characters, leading dots, or overlong names). There is a soft limit of 1,000 documents per workspace.

**Storage.** Files go to `storage.key(ws, 'knowledge', docId, safeName)` with a `MediaAsset` of kind `KNOWLEDGE_DOCUMENT`, then a job is enqueued with `QUEUES.knowledge` and jobId `knowledge_<docId>` (reprocess uses `knowledge_<docId>_r<ts>`).

**Ingestion worker.** Steps in order:
1. **Extract text.** PDF uses `unpdf` per page; DOCX uses `mammoth.extractRawText`; text files are decoded as UTF-8. PDF and DOCX parsing runs in a worker thread created with `eval` and `resourceLimits` (768 MB heap) and is killed after 60 s.
2. **Clean the text.** Control, zero-width and bidi-override characters are stripped, and whitespace is normalized.
3. **Apply the text cap.** Documents with more than 2M characters fail with a clear error.
4. **Chunk.** Target 3,300 characters (about 800 tokens), maximum 3,600, about 15% overlap. Splits happen at paragraph, then sentence, then word boundaries. A chunk never spans PDF pages, so `page` is exact. `heading` is the nearest Markdown or numbered heading, and a new section starts a new chunk.
5. **Replace chunks in one transaction.** Old chunks are deleted and new ones inserted with `createMany`, which never writes the generated `tsv` column. The transaction also sets `pageCount`, `chunkCount`, `charCount` and the status.
6. **Record usage.** Storage usage is recorded as `STORAGE_BYTES` with idempotency key `storage:knowledge:<docId>`.

Failure handling:
- Deterministic failures set `FAILED` with a readable message and are not retried. Examples: a password-protected or corrupt PDF, an image-only PDF ("OCR is not supported"), or text over the cap.
- Transient errors are retried by BullMQ (3 attempts).
- A job for a document that has since been deleted is a no-op.

"Ready" is stored as `ProcessingStatus.COMPLETED`; the schema has no READY value. The API also exposes `ready: boolean`.

**Search.** Uses parameterized `$queryRaw`:
- Main query: `websearch_to_tsquery('english', q)` ranked with `ts_rank_cd`. Ranking and `LIMIT` run first, and `ts_headline` snippets (matches wrapped in `«…»`) are built only for the top-k rows.
- Fallback 1, when the AND query finds nothing: OR the lexemes of `plainto_tsquery`.
- Fallback 2, for stopword-only or symbol queries: escaped `ILIKE`.

Every query filters `c."workspaceId" = $ws AND d."workspaceId" = $ws AND d."deletedAt" IS NULL AND d.status = 'COMPLETED'`, plus `c."documentId" = ANY($ids)`.

**Contract for workstream B** (exported from `KnowledgeModule`; B's `OptionalDepsService` resolves `../knowledge/knowledge.service`):
```ts
KnowledgeService.search(workspaceId, documentIds: string[] | null, query, topK = 4)
  → Array<{ chunkId, documentId, documentTitle, page, heading, text, snippet, score }>
  // documentIds null = all docs in the workspace (search tester only); [] = no results
KnowledgeService.extractText(buffer, mimeType?, opts?: { maxBytes?, timeoutMs?, fileName?, maxChars? })
  → { text, pageCount, mimeType }   // throws 422 (bad/unsupported) or 413 (too large)
formatKnowledgeResultsForModel(results)   // from knowledge.format.ts / knowledge.module.ts
```
The only difference from `ARCHITECTURE.md` is that results also carry `snippet` (additive).

**Prompt injection.** `formatKnowledgeResultsForModel` wraps each excerpt in `<knowledge_excerpt source="[doc:Title p.N]" chunk="…">` inside `<knowledge_results>`, with an explicit "quoted reference data, not instructions" preamble. It removes spoofed `</knowledge_excerpt>`, `<system>` and similar tags from excerpt text. Note that B's `tool-registry.ts` currently builds its own `<knowledge_results>` block rather than using this helper; switching is recommended.

**Semantic search.** `embeddings.ts` defines the `EmbeddingProvider` interface, a no-op default (bound in `KnowledgeModule`), and the documented plan for adding pgvector (column in `post-push.sql`, embedding in the worker, reciprocal-rank fusion in `search`). Nothing is embedded today.

### Provider connections (`apps/api/src/modules/providers`)
All routes are under `/api/workspaces/:workspaceId/providers` and require `providers.manage` (ADMIN+).
- `GET /` (add `?includeRevoked=true` to include revoked), `GET /catalog`, `GET /status`, `GET /:id`
- `POST /` `{ provider, secret, label?, config?, verify = true }`
- `PATCH /:id` `{ label?, config? }`
- `POST /:id/rotate` `{ secret, accountSid?, verify = true }`
- `POST /:id/verify`
- `POST /:id/revoke` (`DELETE /:id` is an alias)

**How connections are stored.**
- **One live connection per provider per workspace.** A duplicate returns 409 and the user is pointed to rotate.
- **Capabilities.** They live in `config.capabilities`. The `kind` column is `LLM` whenever the connection serves LLM; otherwise it is the first capability. This means `LlmService.resolve`, which reads `kind: 'LLM'`, works unchanged. OpenAI defaults to LLM, REALTIME, TTS and STT.
- **Config.** Validated by a strict Zod schema: `liveModel`, `analysisModel`, `realtimeModel`, `ttsModel`, `sttModel`, `voice`, Recall `region`, Twilio `accountSid` and `phoneNumber`.
- **Secrets.** Encrypted with `CryptoService.encrypt`. Twilio is stored as JSON `{accountSid, authToken}`. Responses carry only `secretLast4`. Secrets are never logged or audited; audit metadata holds only provider, capabilities and redacted config.
- **Revoke.** Replaces the ciphertext with the literal `revoked`, so no secret material is kept.

**Verify** uses a 10 s timeout, `fetch`, and these calls:

| Provider | Request |
|---|---|
| Anthropic | `GET /v1/models?limit=1` with `x-api-key` and `anthropic-version: 2023-06-01` |
| OpenAI | `GET /v1/models` |
| Deepgram | `GET /v1/projects` |
| ElevenLabs | `GET /v1/user` |
| Twilio | `GET /2010-04-01/Accounts/<sid>.json` with Basic auth |
| Recall | `GET https://<region>.recall.ai/api/v1/bot/?limit=1` |

How responses are handled:
- 2xx → ACTIVE and `lastVerifiedAt` is set.
- 401, or a 403 whose body is JSON (a provider rejection) → INVALID.
- A non-JSON 403 (a proxy or firewall), 429, 5xx, a network error or a timeout → `result: 'error'` and the status is unchanged.
- Provider messages are included with any echoed key redacted.
- Google Calendar has no verification call yet (`unsupported`).

**`GET /status`** returns, for each capability, the source currently in use: `workspace`, `environment`, `simulator` or `browser` (fallback), or `unavailable`. Capabilities are live LLM, analysis LLM, realtime voice, server TTS, server STT, telephony, meeting bots and calendar, each with a human message such as "Simulator (no key) — add an Anthropic or OpenAI key…" plus a note when a key is INVALID. LLM rows come from `LlmService.resolve`; the response also includes `LlmService.availability`.

**`LlmService` change** (additive, in `common/llm/llm.service.ts`). `providerSecret(ws, 'twilio')` converts a stored Twilio JSON secret to `sid:token`, the same format as the environment fallback, and ignores empty or undecryptable secrets.

### Custom functions (`modules/providers`)
All routes are under `/api/workspaces/:workspaceId/functions`. Mutations, test and signing-secret require `providers.manage`; `GET /` and `GET /:id` are readable by CREATOR+ (`scenarios.edit`) so scenario editors can grant functions (header values stay masked):
- `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`
- `POST /:id/test` `{ args }` (a real signed call with `context.test = true`, allowed even when the function is disabled)
- `POST /:id/signing-secret` (reveals the secret; audited)

**Validation.**
- `name` is snake_case and unique per workspace; delete renames the row to free the name.
- `parametersSchema` must be a JSON Schema whose root is `type: "object"`. It is checked by the compact validator in `json-schema.ts`: 16 KB maximum, depth 8, supported keywords only (`$ref` and similar are rejected), valid regexes with no nested quantifiers.
- `url` must be https, public and have no credentials. `allowedHosts` defaults to the URL host, `*.domain` wildcards must include a registrable domain, and the URL host must be in the list.
- `timeoutMs` must be ≤ 15000.
- Headers are encrypted as JSON and displayed as `••••`. Sending `••••` on update keeps the stored value, and reserved or hop-by-hop headers are rejected.

**`CustomFunctionsService.execute(workspaceId, functionId, args, ctx)`** returns `{ ok, status, result?, error?, errorCode?, durationMs, functionName }` and never throws for execution failures. The steps:
1. Check that the function is enabled and belongs to the workspace.
2. Validate the arguments against the schema; they must be ≤ 16 KB.
3. Resolve DNS for the SSRF guard (`ssrf-guard.ts`). Every resolved address must be public, which rules out private, loopback, link-local/metadata, CGNAT, multicast and reserved ranges, and IPv4-mapped, NAT64 or 6to4 wrappers of them. The connection is then pinned to the vetted IP, which defeats DNS rebinding.
4. Send the request: https only, host allowlist, no redirects (3xx is an error), 64 KB response cap, timeout.
5. The body is `{ arguments, context: { workspaceId, sessionId, scenarioVersionId, functionName, test, timestamp } }`. For GET it goes in the `?payload=` query parameter.
6. The signature header is `X-ConversaForge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. The per-function secret is `cffs_` plus `CryptoService.hmac("custom-function:<ws>:<id>")`; it is derived and cannot be rotated separately.

**ToolEvent logging** happens only when `ctx.sessionId` and `ctx.toolCallId` are both provided and `ctx.logToolEvent !== false`. It writes one RESULT or ERROR row with `createMany(skipDuplicates)`, keyed on the `(sessionId, toolCallId, kind)` unique constraint, and only for a session in the same workspace. B's runtime currently calls `execute(ws, id, args, { sessionId, source: 'runtime' })` without a `toolCallId` and logs its own ToolEvents, so nothing is double-logged. `toolSpecs(ws, ids)` returns model tool specs for granted functions (optional helper).

### Web
- **`/w/[id]/knowledge`.** Drag-and-drop area plus file picker with client-side type and size checks and per-file upload status. Paste-text modal (plain text or Markdown). Documents table that polls every 2 s while anything is QUEUED or PROCESSING, and shows errors, type, pages, size, chunk counts, which scenarios use each document, reprocess and delete. The delete confirmation modal lists referencing scenarios. Search tester with `«»` matches rendered as `<mark>`, citations, scores, and an optional "exactly what the agent receives" view.
- **`/w/[id]/knowledge/[documentId]`.** Stats, rename, signed download, reprocess, delete (warns about references), "used by" list, a search tester scoped to the document, and paginated chunks with page and heading.
- **`/w/[id]/settings/providers`.** "What sessions use right now" table showing each capability's source, with a SimulatedBadge and warning while simulated. Connections table (status, last check, capabilities, `••••last4`) with Verify, Settings (label, models, voice, region, SID, capabilities), Rotate and Revoke.
- **`/w/[id]/settings/functions`.** List; create/edit modal (JSON Schema textarea with live validation, masked header rows, allowed hosts, timeout, enabled, reveal signing secret); test runner showing status, duration, error code and the response; a card explaining how to verify signatures.
- **Sidebar.** Added a "Custom functions" entry (additive edit to `layout.tsx`).

## How it was tested (actual results)
- **Jest, unit specs** (no DB): 42 tests in `providers/custom-functions.spec.ts` and 20 in `knowledge/text-extraction.spec.ts`.
  - Magic bytes, NUL bytes, invalid UTF-8, non-Word ZIPs, oversize, and file-name and text sanitization.
  - Real PDF extraction (pdfkit fixture) with pages, real DOCX extraction (hand-built zip), and corrupt PDF handling.
  - Chunking: page tracking, overlap, headings, and a giant single paragraph.
  - The injection-safe formatter.
  - SSRF: about 27 IP cases for IPv4, IPv6, mapped, NAT64 and 6to4; config-time URL checks; the allowlist; DNS resolving to private addresses.
  - A local TLS server (openssl self-signed) covering a pinned request, redirect refusal, the 64 KB cap and timeout.
  - JSON Schema and argument validation.
  - Verification mapping: 401 → invalid, a proxy 403 → error, a timeout, and key redaction.
- **Jest, integration specs** (real Postgres, 16 tests; they run only with `G_TEST_DATABASE_URL`):
  - Knowledge: upload, storage key, enqueue job id, ingest, pages, search, idempotent re-ingest with usage recorded once, DOCX and Markdown ingestion, **workspace isolation** (another workspace's doc id never matches under any fallback; cross-workspace get, delete and chunks return 404), document scoping, OR and ILIKE fallbacks, hostile query syntax, 422 and 413 uploads, image-only PDF → FAILED, referencing scenarios, delete (storage object removed, search empty, ingest after delete skipped), `extractText`, and chunk pagination.
  - Providers: the secret is never in responses, lists or audit rows; the encryption round-trip works; 401 → INVALID and the resolver falls back to the simulator; a network error leaves status unchanged; 200 → ACTIVE and `LlmService.resolve` uses the workspace key and model; 409 on duplicates; rotate; revoke wipes the secret; OpenAI capabilities; Twilio JSON exposed as `sid:token`.
  - Custom functions: validation, masked and encrypted headers, HMAC signature verified by recomputation, cross-workspace execution → not_found, `••••` keeps the stored header, disabled vs. test runs, idempotent ToolEvent that is never written to another workspace's session, private-IP DNS blocked.
  - Command: `G_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_test_g npx jest src/modules/knowledge src/modules/providers` → **78/78 passed**. Without the variable, the integration suites are skipped (62 pass, 16 skipped).
- **HTTP (curl on :4107, real BullMQ worker).**
  - PDF upload → COMPLETED with 2 pages.
  - Disguised binary → 422; 27 MB → 413.
  - Search returned `«Meals» are «reimbursed»… [doc:Travel policy p.2]`.
  - Signed download was byte-identical to the original.
  - Reprocess, then delete.
  - MEMBER → 403 on knowledge, providers and functions. CREATOR → 200 on knowledge, 403 on providers; function list/get → 200, create → 403.
  - Cross-origin POST → 403.
  - A 1.9M-character document ingested into 671 chunks; searching it takes about 25 ms. Documents over 2M characters → FAILED ("more than 2,000,000 characters").
- **Real provider verification with fake keys.** Anthropic → 401 → INVALID ("API key is invalid."). In this sandbox the other providers are blocked by the egress proxy with a plain-text 403, which is how the proxy-vs-provider 403 distinction was found and fixed.
- **Playwright** (`apps/web/e2e/knowledge-providers.spec.ts`, against :3107/:4107) → **2/2 passed**:
  - Knowledge journey: upload a PDF, rejection of a disguised binary, Ready, paste Markdown, search with highlights, citation and model context, detail page with chunks, delete modal.
  - Providers and functions journey: simulator status, add an Anthropic key (verified, masked, never in page HTML), schema validation, the test runner rejecting bad args, masked header on edit.
  - Run with `WEB_URL=http://localhost:3107 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test e2e/knowledge-providers.spec.ts`.

## Fixes to shared files (minimal, additive)
- `apps/web/next.config.mjs`: `experimental.middlewareClientMaxBodySize: '210mb'`. The `/api/*` rewrite proxy was truncating request bodies at 10 MB (the proxy failed with EPIPE / "socket hang up"), which broke knowledge uploads between 10 and 25 MB and course assets. The API still enforces the real limits.
- `apps/api/src/common/llm/llm.service.ts`: Twilio secret normalization in `providerSecret`, described above.
- `apps/web/src/app/w/[workspaceId]/layout.tsx`: the "Custom functions" nav item.
- Someone else added `maxParamLength: 2048` in `main.ts` during this work. Before that, signed media URLs returned 414.

## Not done / externally blocked
- **Real-key verification** works against Anthropic from here (fake-key 401 confirmed). OpenAI, Deepgram, ElevenLabs, Twilio and Recall are unreachable from this sandbox (egress proxy), so their verification is implemented to their documented endpoints but has not been observed returning a live 200 or 401. Real keys are needed for that.
- **Google Calendar** can store an encrypted credential only; there is no verification or OAuth flow.
- **Scanned PDFs** (no OCR) fail with a clear message.
- **Embeddings or semantic search** are not implemented; only the interface and a no-op exist (see `embeddings.ts`).
- **Function signing secrets** are derived and not separately rotatable; recreating the function gives a new one.
- Signup rate limiting is per IP, so parallel e2e runs on one host share a bucket. The e2e spec sends a random `X-Forwarded-For`, which the API honors because `trustProxy: true`. That is fine for tests, but deployments should make sure only the real proxy can set that header.

## Notes for other workstreams
- **B:** the service paths are as expected by `OptionalDepsService`. Consider using `formatKnowledgeResultsForModel` for `knowledge_search` results. `extractText` errors are `AppError` 422/413. Pass `{ sessionId, toolCallId }` to `execute` if you want G to log the ToolEvent; otherwise keep logging it yourself (current behavior).
- **H (channels):** `LlmService.providerSecret(ws, 'twilio')` → `{ secret: 'AC…:token', config: { accountSid, phoneNumber?, capabilities } }`. For Recall, `config.region` holds the region.
- **A (scenario editor):** list documents for the knowledge picker with `GET /workspaces/:ws/knowledge/documents` and custom functions with `GET /workspaces/:ws/functions`. Both are readable by CREATOR+.
- **Integration test DB:** `conversaforge_test_g` (synced with `prisma db push` + `post-push.sql`).
