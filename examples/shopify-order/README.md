# app-shopify-order

Dogfood third-party app for the ChatDaddy app store ("private tier": `handler.type: url`).
It starts a flow when Shopify sends an `orders/create` webhook, and offers one flow action
that formats an order confirmation message. Zero runtime dependencies; Node 22 ESM, plain JS.

## Env vars

| Var | Required | Meaning |
|---|---|---|
| `SHOPIFY_WEBHOOK_SECRET` | yes | Shopify webhook signing secret for the shop |
| `CHATDADDY_BOTS_URL` | yes | bots base URL; triggers are POSTed to `{url}/apps/triggers/{installationId}/shopify-order-created` |
| `PORT` | no | default 3000 |
| `DATA_FILE` | no | installation store, default `./data/installations.json` (holds signing secrets in plaintext, mode 0600) |
| `APP_ID` | no | must equal the manifest `id`, default `shopify-order-whatsapp` |
| `CHATDADDY_PUBLIC_KEY` | no | PEM override for the ES256 key; default is ChatDaddy's key copied from `@chatdaddy/client` |

## Run / test

```
node src/main.mjs        # or: npm start
npm test                 # node --test test/*.test.mjs
npm run mutate           # mutation check: disables each guard, expects the suite to go red, restores
```

Validate the manifest with the builder kit, the same rules ChatDaddy applies when a version is published (from the repo root):

```
node packages/create-chatdaddy-app/bin/create-chatdaddy-app.mjs validate examples/shopify-order/chatdaddy-app.json
```

Set `handler.baseUrl` in `chatdaddy-app.json` to the real https URL before publishing.

## Contract

Source of truth: bots `src/utils/app-signing.ts`, `app-handshake.ts`, spec `P2-5-6-EXECUTE-AND-TRIGGER-SPEC-rev2.md`.

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
- `POST /shopify/webhook/{installationId}` (Shopify -> app). `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body) is checked first (401 otherwise).
  Only `orders/create` is forwarded; orders with no phone or order number are acknowledged and skipped.
  The mapped payload `{ orderId, customerName, phone, total, currency, itemsSummary }` is POSTed to bots with
  `x-chatdaddy-event-id: <X-Shopify-Webhook-Id>` (so Shopify retries de-dupe) and an app-to-bots `x-chatdaddy-signature`.
  A bots non-2xx or network failure returns 502 so Shopify retries.
- Trigger payload is declared as `payloadSchema` (the appstore manifest has no trigger `outputProperties`).
