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
<div id="cf-call" style="height:640px"></div>
<script src="https://YOUR-CONVERSAFORGE-HOST/embed.js"></script>
<script>
  ConversaForge.init({ container: '#cf-call', token: 'cfe_…', onEvent: (e) => console.log(e.type, e) });
</script>
```

The SDK hands the token to the iframe with `postMessage`, never in a URL. The frame then calls:

- `GET /api/public/embed/token-info` (`Authorization: Bearer cfe_…`): scenario info and the token's allowed origins, so the frame can refuse to run on a wrong site before anything starts.
- `POST /api/public/embed/sessions` (`Authorization: Bearer cfe_…`, body `{ parentOrigin, variables? }`): returns `{ sessionId, sessionToken, allowedOrigins }`. The page may only supply allowlisted variables that the token left unset.

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
