# app-shopify-order

Dogfood third-party app for the ChatDaddy app store ("private tier": `handler.type: url`).
It starts a flow when Shopify sends an `orders/create` webhook, and offers one flow action
that formats an order confirmation message. Zero runtime dependencies; Node 22 ESM, plain JS.

## Env vars

| Var | Required | Meaning |
|---|---|---|
| `WEBHOOK_SECRET_KEY` | yes | 32-byte key that seals each shop's Shopify webhook secret at rest (AES-256-GCM): 64 hex characters or base64. Generate one with `openssl rand -hex 32`. Keep it out of the data file's backups. Losing or changing it makes every stored webhook secret unreadable, and the admin has to paste them again |
| `ADMIN_TOKEN` | yes | at least 24 characters. An operator-only credential for the person who runs this app; do not hand it to each team. It is the bearer token used to paste a shop's webhook secret (see below). Generate one with `openssl rand -hex 32` |
| `CHATDADDY_BOTS_URL` | yes | bots base URL; triggers are POSTed to `{url}/apps/triggers/{installationId}/shopify-order-created` |
| `PORT` | no | default 3000 |
| `DATA_FILE` | no | installation store, default `./data/installations.json` (holds ChatDaddy signing secrets in plaintext and the Shopify webhook secrets sealed; mode 0600) |
| `APP_ID` | no | must equal the manifest `id`, default `shopify-order-whatsapp` |
| `CHATDADDY_PUBLIC_KEY` | no | PEM override for the ES256 key; default is ChatDaddy's key copied from `@chatdaddy/client` |

## Connect a Shopify store (per installation)

Every installation has its own Shopify webhook secret, so one store's webhooks can never be checked with another store's secret. After the team installs the app (ChatDaddy has then called `POST /installed`; note the installation id), the admin does two things.

1. **Give the app the shop's webhook signing secret.** In the Shopify admin: Settings, Notifications, Webhooks, and copy the line that says "Your webhooks will be signed with ..." (that is the signing secret for webhooks you create there; for a webhook created by a custom app, use that app's client secret). Then send it to your app over HTTPS:

   ```
   curl -X POST "https://<your-app-host>/installations/<installationId>/shopify-webhook-secret" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "secret": "<paste the shop signing secret>" }'
   ```

   It answers `{ "ok": true }` and never repeats the secret. Posting again replaces it. An unknown installation answers 404; a wrong token, 401.

2. **Register the webhook URL in Shopify.** Settings, Notifications, Webhooks, Create webhook:
   - Event: `Order creation`
   - Format: `JSON`
   - URL: `https://<your-app-host>/shopify/webhook/<installationId>` (the installation id in the URL is what selects the secret; use the id of the installation that belongs to this shop)
   - Save, then use "Send test notification". A 401 means the signature did not match (or the installation id or secret is wrong); a 200 only means the request was accepted, which also happens for ignored topics and for orders with no phone number.

Until step 1 is done every webhook for that installation is refused with 401. Another shop, another installation: repeat both steps with that installation's id.

When the team uninstalls the app, ChatDaddy calls `POST /uninstalled` (signed by ChatDaddy under its own `uninstalled` label), and the app deletes that installation's record: its signing secrets and its sealed Shopify secret. Remove the webhook in Shopify too; the app cannot do that for you.

## Run / test

```
node src/main.mjs        # or: npm start
npm test                 # node --test test/*.test.mjs
npm run mutate           # mutation check: disables each guard, expects the suite to go red, restores
```

## Deploy

Apps run on Fly.io (decided with the platform; the Hangar's workers run there too, region `sin`). `fly.toml` is one machine, one volume, public HTTPS from Fly's proxy.

```
export FLY_API_TOKEN=...                                    # a Fly token for the org; never printed
export CHATDADDY_BOTS_URL=https://api.chatdaddy.tech/bots   # the bots base URL
examples/shopify-order/deploy-fly.sh
```

The script creates the Fly app (`FLY_APP`, default `chatdaddy-app-shopify-order`; `FLY_ORG` if you have several) and the `shopify_order_data` volume if missing, generates `WEBHOOK_SECRET_KEY` and `ADMIN_TOKEN` with `openssl rand -hex 32` and sets them as Fly secrets only if they are not set yet (re-running never rotates them), sets `CHATDADDY_BOTS_URL`, runs `fly deploy`, and prints `https://<app>.fly.dev`, which is what `publish --base-url` takes.

- Reading `ADMIN_TOKEN` back (step 5 of [E2E.md](E2E.md) needs it): `fly ssh console -a <app> -C 'printenv ADMIN_TOKEN'`, or the person who ran the script keeps it. `fly secrets list` shows only digests. Do not write it to a file.
- Exactly one machine, never stopped or scaled: the installation store is one local file with a single writer.
- Any other host works too: build `examples/shopify-order` (`docker build -t app-shopify-order examples/shopify-order`), mount persistent storage at `/data`, set the three required env vars, and put public HTTPS in front of port 3000. `GET /healthz` answers `{ "ok": true }`.
- Env vars: the table above. `DATA_FILE` is preset to `/data/installations.json`, `PORT` to 3000. `WEBHOOK_SECRET_KEY`, `ADMIN_TOKEN` and `CHATDADDY_BOTS_URL` are required; the container exits at start if they are missing.
- Volume: without one every restart forgets every installation. Run a single instance.
- A volume arrives owned by root (Fly does this), so the container starts as root, `docker-entrypoint.sh` chowns `/data` to the `node` user, and the app runs as `node` (not root).

## Publish

From the repo root, with a ChatDaddy token that has the `APPS_DEVELOP` scope (its team owns the app and installs it):

```
export CHATDADDY_TOKEN=...
node packages/create-chatdaddy-app/bin/create-chatdaddy-app.mjs publish examples/shopify-order/chatdaddy-app.json \
  --version 0.1.0 --base-url https://<your-app-host>
```

`--base-url` replaces `handler.baseUrl` for this publish, so the JSON is never edited by hand. Versions are immutable: a change means a new `--version`. The full go-live walkthrough is in [E2E.md](E2E.md).

Validate the manifest with the builder kit, the same rules ChatDaddy applies when a version is published (from the repo root):

```
node packages/create-chatdaddy-app/bin/create-chatdaddy-app.mjs validate examples/shopify-order/chatdaddy-app.json
```

## Contract

Source of truth: ChatDaddy's app signing and handshake contract, as implemented by this example and checked by its tests.

- Signature header: `t=<unix>,v1=<hex HMAC-SHA256>`, 300s tolerance, strict parse, constant-time compare.
  Signed content is prefixed by a direction label: app-to-bots `chatdaddy/v1/app-to-bots.<t>.<eventId>.<body>`,
  bots-to-app `chatdaddy/v1/bots-to-app.<t>.<body>`, ack `HMAC(secret, "chatdaddy/v1/handshake-ack:" + nonce)` (hex).
- `POST /installed` (bots -> app). `Authorization: Bearer <ES256 JWT>`; body `{ installationId, teamId, appId, appVersion, grantedScopes, signingSecret, nonce }`.
  The JWT is verified against ChatDaddy's key, must not be expired, and `user.metadata` must be
  `{ type: 'app', objectId: 'app_<appId>/inst_<installationId>' }` with `user.teamId == body.teamId`; `body.appId` must be this app.
  Any failure: 401, nothing stored. Success: secret stored, reply `{ ack }`. A re-handshake with a new secret keeps the old one valid for 15 minutes.
- `POST /actions/{actionId}` (bots -> app). Headers `x-chatdaddy-signature` (bots-to-app) and `x-chatdaddy-installation`;
  verified over the raw body with that installation's secret(s). Unknown installation and bad signature both answer 401.
  Body `{ input, context, settings }`; the response body is the action output (`format-order-message` -> `{ message }`).
- `POST /uninstalled` (bots -> app). Headers `x-chatdaddy-installation` and `x-chatdaddy-signature`, signed with that installation's secret under its own label: content `chatdaddy/v1/uninstalled.<t>.<body>`, same `t=<unix>,v1=<hex>` header and tolerance as the others, so an action call can never replay as an uninstall. The body must be `{ "event": "uninstalled", "installationId", "teamId", "appId" }` and its `installationId` must equal the header. Success: the installation's record, sealed webhook secret included, is deleted and the reply is `{ ok: true }`. Unknown installation, bad signature, wrong event or mismatched installation: 401.
- `POST /installations/{installationId}/shopify-webhook-secret` (admin -> app). `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compare), body `{ secret }` (8 to 256 printable characters, no spaces). The secret is sealed with AES-256-GCM, bound to the installation id, and never logged or returned.
- `POST /shopify/webhook/{installationId}` (Shopify -> app). The secret is that installation's own. `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body, constant-time compare) is checked first; an unknown installation, an installation with no secret yet and a bad signature all get the same bare 401.
  Only `orders/create` is forwarded; orders with no phone or order number are acknowledged and skipped.
  The mapped payload `{ orderId, customerName, phone, total, currency, itemsSummary }` is POSTed to bots with
  `x-chatdaddy-event-id: <X-Shopify-Webhook-Id>` (so Shopify retries de-dupe) and an app-to-bots `x-chatdaddy-signature`.
  A bots non-2xx or network failure returns 502 so Shopify retries.
- Trigger payload is declared as `payloadSchema` (the appstore manifest has no trigger `outputProperties`).
