# e2e-local: rehearse the Shopify order launch on one machine

Runs the real chatdaddy-service-bots, the real `examples/shopify-order` app, a real localstack KMS and a Postgres database of its own. Only appstore and auth are stubbed (a few routes, in `run.mjs`). It follows [E2E.md](../../examples/shopify-order/E2E.md) up to the WhatsApp send and stops there: it never touches IM or WhatsApp, and never leaves your machine.

```
BOTS_DIR=/path/to/chatdaddy-service-bots \
  mise x node@22 -- node scripts/e2e-local/run.mjs
```

It prints PASS, FAIL or SKIP per step and tears everything down (processes, the database, the localstack container). Exit code 1 if any step fails.

## Needs

- `BOTS_DIR`: a bots checkout (origin/main) with `node_modules` installed. Needs `@swc-node/register`.
- Docker (localstack; the image must be `localstack/localstack:3.8` or set `LOCALSTACK_IMAGE`. `:latest` now refuses to start without an auth token).
- Postgres at `E2E_PG_URL` (default `postgres://postgres@127.0.0.1:5432`, trust auth). The run creates and drops `e2e_local_<random>`.
- `openssl`, and a free port 3001 (bots has no PORT setting).
- Optional: `APP_DOCKER_DIR=examples/shopify-order` (builds the example's Dockerfile and runs it as the container instead of `node src/main.mjs`; Linux, uses host networking), `AMQP_URI` (silences bots' "AMQP connect failed" logs; nothing here needs events).

## Steps

| Step | What is checked |
|---|---|
| 1a | database created, bots migrations run |
| 1b | bots server boots, accepts a real ES256 token (`PUBLIC_KEY` env) on `GET /bots/installations` |
| 2a, 2b | localstack KMS up, key created; bots' `connection-crypto` seals and opens through it using only `AWS_ENDPOINT_URL_KMS` and dummy credentials |
| 3 | the app answers `/healthz` over HTTPS (self-signed cert for a fake host) |
| 4a | `create-chatdaddy-app publish` against the stub appstore |
| 4b | `POST /bots/installations`, then bots' real handshake job: mint app token, `POST /installed`, ack check, status `active` |
| 5 | admin route stores a dummy shop secret; a wrong-HMAC webhook gets 401, a correctly signed `orders/create` gets 200 |
| 6a | the app's signed trigger reached `appTriggerIngest` and was accepted (replay row in `trigger_event_seen`) |
| 6b | `executeAppAction` (the helper a flow's app step calls) gets `{ message }` from `format-order-message` |
| 7 | stop. In a real flow the next step is the WhatsApp send after `getOutputFromApp` (`src/utils/app-utils.ts`) |

## Test seams (no bots source is changed)

`preload.cjs` is loaded into the bots process with `node -r`. It does three things, each because bots deliberately cannot be pointed at localhost:

1. `@chatdaddy/client` hardcodes `https://api.chatdaddy.tech/...`. appstore and auth calls are rewritten to the stub; any other chatdaddy.tech call is refused.
2. `handler.baseUrl` must be https and `safe-egress.ts` refuses loopback. For one fake host name (`shopify-app.e2e.test`) the DNS answer is forced to 127.0.0.1. The guard stays on for every other host, and a connection to any other non-local host throws.
3. `NODE_EXTRA_CA_CERTS` trusts the run's self-signed cert.

`bots-probe.cjs` runs inside bots' process to call the cron handshake body and `executeAppAction` directly (a flow has no public route for either).

## Not rehearsed

The real appstore and auth (their routes are stubs shaped from the appstore OpenAPI), the dashboard install and consent screen, the flow builder and trigger binding (so no flow fires), the SSRF guard on the public-DNS path, real Shopify, WhatsApp/IM, prod KMS IAM and the prod cron pod, TLS from a real proxy, the Docker volume ownership on a host.
