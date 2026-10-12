# ChatDaddy for Shopify

The real Shopify app (design: `SHOPIFY-APP-DESIGN-rev0.md`, tickets S-1 and S-2). A first-party `url` app: Shopify webhooks become ChatDaddy flow triggers, and two flow actions read from Shopify. `examples/shopify-order` stays as the minimal example. Zero dependencies; Node 22.13+ (`node:sqlite`).

## What it does

| Trigger | From Shopify topic | Notes |
|---|---|---|
| `order-created` | `orders/create` | `isCod`, `paymentGateway` for the COD flow (S-5) |
| `order-fulfilled` | `fulfillments/create` | tracking company, number, URL |
| `order-delivered` | `fulfillments/update` | only when `shipment_status` is `delivered`; once per fulfillment |
| `checkout-abandoned` | `checkouts/create`, `checkouts/update` | once per checkout, only with a phone and not completed; `checkoutUrl`, `marketingConsent` |

| Action | Does |
|---|---|
| `is-checkout-open` | is the checkout still open (exists, not completed)? For the cart flow's condition after a delay |
| `get-latest-order-for-contact` | latest order by phone, with status and tracking |

Every trigger payload has `phone` in E.164 (`src/phone.mjs`). An order, fulfillment or checkout with no usable phone is acknowledged (200) and skipped; the reason is logged (never the number).

## State: SQLite

`node:sqlite` (built into Node 22.13+, no dependency; prints an ExperimentalWarning). One file, `DATA_FILE` (default `./data/app.db`, `/data/app.db` in Docker, on the Fly volume, single machine). Tables: `installations` (shop <-> installation, ChatDaddy signing secrets in plaintext, so protect the volume), `webhooks` (Shopify subscription ids), `dedupe` (webhook ids and once-per-thing keys, pruned after 7 days). Uninstall deletes every row of the installation.

## Env vars

| Var | Required | Meaning |
|---|---|---|
| `SHOPIFY_CLIENT_SECRET` | yes | the Shopify app's client secret; signs every webhook (HMAC) |
| `CHATDADDY_BOTS_URL` | yes | triggers go to `{url}/apps/triggers/{installationId}/{triggerId}` |
| `PUBLIC_URL` | yes | this app's public https URL; webhook callbacks are `{PUBLIC_URL}/shopify/webhook/{installationId}` |
| `PORT`, `DATA_FILE`, `APP_ID` (`chatdaddy-shopify`), `CHATDADDY_PUBLIC_KEY` | no | as in the example |

## Routes

- `POST /installed`, `POST /uninstalled`, `POST /actions/:id`: the contract in `examples/shopify-order/README.md`.
- `POST /connected` (bots -> app): the `connected` lifecycle event. **Assumed shape** (P5 A-6 not built): signed like an action call, body `{ event: 'connected', installationId, connection: { id, inputs: { shop } } }`. Stores the shop and registers the five webhook subscriptions through the proxy (idempotent). 502 on proxy failure so bots can retry; 409 if the shop belongs to another installation.
- `POST /shopify/webhook/:installationId` (Shopify -> app): HMAC (`X-Shopify-Hmac-Sha256`) with the client secret, and `X-Shopify-Shop-Domain` must match the installation's shop; unknown installation, bad signature and wrong shop are one bare 401. Dedupe by `X-Shopify-Webhook-Id`; answers 200 at once, then delivers to bots in the background (3 retries, 1 s / 5 s / 30 s, same event id so bots de-dupes). If all fail it is logged and given up: the retry queue is in memory, lost on restart.

## Connection proxy

All Shopify calls (webhook registration, the two actions, the fulfillment phone lookup) go through `proxy.graphql({ installationId, query, variables })` (`src/proxy.mjs`). The real client arrives with P5 A-5; `main.mjs` uses `unavailableProxy`, so until then actions answer 502 and `connected` cannot register webhooks. Tests use a fake. Public apps must use the GraphQL Admin API, hence GraphQL, not REST.

## Assumptions to verify at the first real install

- Webhook payload field names (test/fixtures.mjs): REST-style JSON, from memory of shopify.dev, not captured. Notably the fulfillment `destination` object, `name` as `#1001.1`, `shipment_status`, and the consent fields.
- GraphQL: `abandonedCheckouts(query: "id:<n>")`, `customers(query: "phone:+...")`, `orders(query: "customer_id:<n>")`, `Order.statusPageUrl`, `fulfillments.trackingInfo`. `SHOPIFY_API_VERSION` is not pinned here: the proxy owns the version.
- Shopify phone search needs the stored format to match E.164.
- Shopify scopes (manifest): `read_orders`, `write_orders`, `read_customers`, `read_fulfillments`. `read_checkouts` is not requested: as far as known the `checkouts/*` webhooks and abandoned checkouts need `read_orders`. `write_orders` is for S-5 (tag, cancel), `read_customers` for S-4 and the phone lookup.

## Manifest and validation

`chatdaddy-app.json` uses `flavor: "shopify"`, templated `authUrl`/`tokenUrl` (`https://{shop}.myshopify.com/...`) and `TRIGGERS_FIRE`. The builder kit's `validate` does not accept those yet (no `flavor`, templated URLs, stale scope list), so it reports 6 problems that are all kit gaps (kit follow-up, appstore PR #19 side). With those three swapped out it validates. `botsCreate` (S-3) needs `TEMPLATES_CREATE`, which is not app-grantable today: a platform question for S-3.

## Run / test / deploy

```
npm test                       # node --test test/*.test.mjs
SHOPIFY_CLIENT_SECRET=... CHATDADDY_BOTS_URL=... PUBLIC_URL=... node src/main.mjs
FLY_API_TOKEN=... CHATDADDY_BOTS_URL=... SHOPIFY_CLIENT_SECRET=... ./deploy-fly.sh   # Fly app chatdaddy-app-shopify
```

The Dockerfile and entrypoint are the example's (the entrypoint chowns the volume, then drops to `node`).

## Local rehearsal

`scripts/e2e-local` drives `examples/shopify-order`. To rehearse this app: point `APP_DOCKER_DIR`/the spawn at `apps/shopify`, publish its manifest (the stub appstore needs the new connection fields), replace step 5 by a `POST /connected` signed with the installation's secret (needs a fake proxy: start the app with a small wrapper that injects one) and then post webhooks signed with `SHOPIFY_CLIENT_SECRET` instead of pasting a per-shop secret. Not done in this PR.
