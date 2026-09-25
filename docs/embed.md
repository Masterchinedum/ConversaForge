# Embedding ConversaForge on your website

The embeddable widget runs a scenario inside an iframe that ConversaForge serves (`/embed/frame`). It is loaded by the small `embed.js` SDK. An **embed token** (`cfe_…`) authorizes each visitor's session.

> The access layer (tokens, origin checks, the session endpoints) is described here. Workstream C owns the widget and SDK and may add SDK options, events and styling to this page.

## 1. Mint a token on your server

Never put an API key in a browser. Your backend mints a short-lived token for each visitor:

```bash
curl -X POST https://YOUR-CONVERSAFORGE-HOST/api/v1/access-tokens \
  -H "Authorization: Bearer cf_live_…" -H "Content-Type: application/json" \
  -d '{
        "scenarioId": "…",
        "participant": { "externalId": "crm-42", "email": "ada@example.com", "name": "Ada" },
        "variables": { "company": "Example Inc" },
        "allowedOrigins": ["https://www.example.com"],
        "maxUses": 1,
        "expiresInSeconds": 3600
      }'
# → { "token": "cfe_…", "accessToken": { … } }   (the token is shown only once)
```

| Field | Meaning |
|---|---|
| `participant` | Identity attached to the session. `externalId` maps to your own user id, so repeat visits are grouped under one participant. |
| `variables` | Values for the scenario's allowlisted `{{variables}}`. Unknown keys are rejected. These values cannot be overridden from the page. |
| `allowedOrigins` | Sites where the widget may run (`scheme://host[:port]`, no path). Leave empty only for testing. |
| `maxUses` | How many sessions the token can start. Leave it out for unlimited until expiry. |
| `expiresInSeconds` | Default 3600. Maximum 30 days. |
| `pinnedVersionId` | Optional. Run a specific published version. |

For testing, creators can also mint tokens in the app under **Scenario → Share → Embed & access tokens**. Tokens can be revoked there at any time. Revocation, expiry and uses are checked every time a session starts.

## 2. Add the widget

```html
<div id="cf-call"></div>
<script src="https://YOUR-CONVERSAFORGE-HOST/embed.js"></script>
<script>
  // `token` comes from YOUR backend (step 1), e.g. rendered into the page or fetched from your API.
  const call = ConversaForge.init({
    container: '#cf-call',
    token: 'cfe_…',
    height: 680,          // px or any CSS length; default 640
    autoHeight: true,     // grow/shrink with the frame's content (320px … maxHeight)
    onEvent: (e) => {
      if (e.type === 'session.created') saveMapping(e.sessionId);   // your LMS/CRM record ↔ session
      if (e.type === 'session.ended') showNextStep();
      if (e.type === 'error') console.warn(e.code, e.message);
    },
  });
  // call.end();      // end the conversation gracefully (no confirmation dialog)
  // call.destroy();  // remove the iframe and listeners
</script>
```

A copy-paste demo lives at `/embed-example.html` on your ConversaForge host (paste a token and start).

### `ConversaForge.init(options)`

| Option | Type | Meaning |
|---|---|---|
| `container` | element or CSS selector | Where the iframe is inserted. Required. |
| `token` | `cfe_…` string | Private embed token minted by your server (step 1). Identity and variables come from the token. |
| `linkToken` | string | Alternative to `token`: the token of a share link (`/r/<token>`). Use it to embed a public/share-link run. |
| `participant` | `{ name?, email?, externalId? }` | **Link mode only.** Prefills the identity the share link asks for; `externalId` is ignored by share links (use an embed token for identity mapping). Ignored in token mode. |
| `passcode` | string | Link mode only: passcode for protected links. If missing, the frame asks the visitor. |
| `variables` | object | Values for the scenario's allowlisted `{{variables}}` that the token/link left unset (strings ≤ 4000 chars, numbers, booleans; keys `^[a-z][a-z0-9_]{0,47}$`). |
| `baseUrl` | URL | Your ConversaForge host. Defaults to the origin `embed.js` was loaded from. Must be `https` (except localhost). |
| `height`, `autoHeight`, `maxHeight`, `borderRadius`, `title` | | Presentation. |
| `onEvent` | `(event) => void` | Lifecycle events (below). |

Returns `{ iframe, sessionId, end(), destroy() }`.

### Events (`onEvent`)

| `type` | Payload | When |
|---|---|---|
| `session.created` | `{ sessionId, resumed? }` | The session exists (or an unfinished one from this tab was resumed after a frame reload). |
| `ready` | `{ sessionId, state }` | The call UI loaded its session. |
| `session.state` | `{ sessionId, state, reason? }` | State changes: `CONNECTING`, `ACTIVE`, `PAUSED`, `RECONNECTING`, `ENDING`, `COMPLETED`, … |
| `session.ended` | `{ sessionId, reason, endedBy? }` | The conversation ended (completed, ended by the participant/host, timed out…). |
| `identity.required` | `{ name, email, passcode }` | Link mode: the frame is asking the visitor for missing details. |
| `error` | `{ code, message }` | e.g. `origin_not_allowed`, `token_expired`, `token_exhausted`, `missing_token`, `auth`, `start_failed`. |

### Handshake and security

1. `embed.js` creates `<iframe src="https://HOST/embed/frame" allow="microphone; camera; autoplay">`. The URL never contains a token.
2. The frame posts `frame.ready` to its parent (no secrets). The SDK only accepts messages whose `event.origin` is the ConversaForge origin **and** whose `event.source` is its own iframe.
3. The SDK answers with `init` (token, variables, …) using `postMessage(msg, "<ConversaForge origin>")`, so only our frame can read it.
4. The frame accepts `init` only from `window.parent`, records the parent's origin from the browser-supplied `event.origin` (cross-checked with `location.ancestorOrigins` where available), calls `GET /api/public/embed/token-info` and **refuses to start** if the parent origin is not in the token's `allowedOrigins`; it then calls `POST /api/public/embed/sessions` with `parentOrigin` (the server enforces the same list) and re-checks the returned `allowedOrigins`.
5. All events go back with `postMessage(evt, parentOrigin)` — never `*`.
6. The per-session token (`cfs_…`) stays inside the frame (session storage) and is used for the live WebSocket and uploads.

Share-link mode (`linkToken`) calls `GET /api/public/links/:token` and `POST /api/public/links/:token/sessions` with `{ name, email, passcode, variables }`; the link's own rules (identity, passcode, attempt limits, expiry) apply.

### Identity mapping

With an embed token, `participant.externalId` is stored on the ConversaForge **Participant** (unique per workspace), so every session a given user of yours starts is grouped under the same participant — use your LMS/CRM user id. `name`/`email` on the token are shown to reviewers. The page can never change the identity.

### Your site's CSP and iframe notes

- Allow the frame: `frame-src https://YOUR-CONVERSAFORGE-HOST;` and the script: `script-src https://YOUR-CONVERSAFORGE-HOST;` (or self-host a copy of `embed.js`).
- The iframe must be allowed to use the microphone (and camera if the scenario records video). `embed.js` sets `allow="microphone; camera; autoplay"`. If your page sets a `Permissions-Policy` header, include the ConversaForge origin, e.g. `microphone=(self "https://YOUR-CONVERSAFORGE-HOST")`. Nested iframes must delegate the same permissions at every level.
- Microphone access requires HTTPS on both your page and ConversaForge.
- ConversaForge serves `/embed/*` without `X-Frame-Options` and with `Permissions-Policy: camera=*, microphone=*`; all other pages are `SAMEORIGIN`.
- Third-party storage partitioning: the frame keeps its session token in its own (partitioned) `sessionStorage`; reloading the host page in the same tab resumes an unfinished session started by the same token.
- Browser speech recognition (Chrome/Edge) needs the microphone permission delegated to the iframe; when it is unavailable the frame automatically falls back to typing (not verified on real browsers in CI — headless Chromium has no speech service).

## Trust model

- **Tokens are bearer credentials.** Only a SHA-256 hash and a short prefix are stored. Keep TTLs short and use `maxUses` for per-visitor tokens.
- **The origin check applies only when `allowedOrigins` is non-empty:**
  - A direct browser request from your page carries your page's `Origin` header, which must be on the list.
  - Requests from our own iframe carry *our* origin. For these, the frame reports the embedding page's origin as `parentOrigin`. It takes this from the browser-supplied `event.origin` of the parent's `postMessage` handshake, and that value must be on the list.
  - A request with no usable origin is rejected (`403 origin_not_allowed`).
- **What this protects against.** A leaked token cannot be used through a browser on sites you did not list.
- **What it does not protect against.** A non-browser client can forge `Origin` or `parentOrigin`. Short expiry, `maxUses` and revocation are the controls for that case, so treat the token like a short-lived password for one session.
- **Identity** comes only from the token, never from the page.
- **Errors:**
  - `401`: invalid token or wrong type.
  - `403 origin_not_allowed`: the origin is not on the list.
  - `410 token_revoked`, `token_expired`, `token_exhausted`, `scenario_unavailable`.
  - `429`: rate limited.
