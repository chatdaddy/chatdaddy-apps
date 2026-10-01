# chatdaddy-apps

Build apps that run inside [ChatDaddy](https://chatdaddy.tech) flows: triggers that start a flow, and actions a flow can call.

- `examples/shopify-order`: a complete app. A Shopify `orders/create` webhook starts a ChatDaddy flow that messages the customer on WhatsApp. It has no runtime dependencies and is tested with `node:test`.
- `packages/create-chatdaddy-app` (coming next): scaffold a new app, validate its manifest, and run it locally against signed test requests.

## How an app works

1. **Manifest.** `chatdaddy-app.json` declares the app's scopes, its handler (`{ "type": "url", "baseUrl": "https://…" }` for an app you host), its flow triggers (with a `payloadSchema`) and its flow actions (with `inputProperties` and `outputProperties`).
2. **Install handshake.** When a team installs the app, ChatDaddy sends `POST {baseUrl}/installed` with a short-lived ES256 token (verify it with ChatDaddy's public key) and a per-installation signing secret. The app stores the secret and answers with an HMAC acknowledgement.
3. **Triggers.** The app fires a flow trigger with `POST /apps/triggers/{installationId}/{triggerId}` on the ChatDaddy bots API, signed with the installation secret (`x-chatdaddy-signature`, `x-chatdaddy-event-id`).
4. **Actions.** A flow calls `POST {baseUrl}/actions/{actionId}`, signed by ChatDaddy with the same secret and carrying a short-lived token. The app replies with its declared outputs.

Each signature carries a direction label (`app-to-bots`, `bots-to-app`, `handshake-ack`), so a signature made for one direction never verifies in another. The example's `src/signing.mjs` is the reference implementation, and its tests pin the exact byte format.

## Status

Apps are private for now: a team installs apps its own team built. Public listing and ChatDaddy-hosted apps come later.
