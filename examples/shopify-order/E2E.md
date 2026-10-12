# End to end: take the Shopify order app live

Goal: a Shopify order creates a WhatsApp message. Do the steps in order and check each one before the next.

> **Step 8 sends a real WhatsApp message to the order's phone number.** Use a test order with your own number. Never use a customer's.

Placeholders: `<host>` is the public HTTPS host of your container; `<id>` is the installation id from step 4.

## 1. Deploy the container

Build and run it as in the README "Deploy" section (volume at `/data`, three required env vars, public HTTPS in front). Keep `ADMIN_TOKEN` somewhere safe: you need it in step 5.

Check: `curl https://<host>/healthz` returns `{"ok":true}` over valid HTTPS.
Failure: container exits at start (a required env var is missing; the log line names it, never its value); no TLS or connection refused (proxy or port wrong); `/healthz` works over HTTP but not HTTPS (ChatDaddy will refuse an http `baseUrl` at publish).

## 2. Publish

```
export CHATDADDY_TOKEN=...     # token for the team that will install the app, with APPS_DEVELOP
node packages/create-chatdaddy-app/bin/create-chatdaddy-app.mjs publish examples/shopify-order/chatdaddy-app.json \
  --version 0.1.0 --base-url https://<host>
```

Check: it prints `registered new app shopify-order-whatsapp` (or `already registered`), then `published ... version 0.1.0`.
Failure: `INVALID, not publishing` lists the manifest problems (nothing was sent). `HTTP 401/403` means the token is wrong or lacks `APPS_DEVELOP`. `HTTP 409` on the version means 0.1.0 exists already: versions are immutable, so publish a new `--version`. A 409 on `appCreate` means the app id is taken by another team.

## 3. Install from the dashboard

In the ChatDaddy dashboard open your team's apps, find "Shopify order to WhatsApp" and install it. Approve the consent screen (it asks for `ACCOUNT_READ`).

Pre-flight (once, before the first install): the bots web pod AND the bots cron pod both need `APP_CONNECTIONS_KMS_KEY_ID` and the KMS role (`kms:GenerateDataKey`, `kms:Decrypt` on that key). The install seals a secret in the web pod, and the handshake opens it in the cron pod.

The install is created as `pending-handshake`. It becomes `active` only when bots' cron pod runs the handshake job, which runs once a minute; a failed attempt is retried after a 1-minute back-off. Wait up to 2 minutes.

Check: after at most 2 minutes the installation's status reads `active`, and the app's container log has one line `{"msg":"request","method":"POST","route":"/installed","installationId":"<id>","status":200}` (it never logs bodies, secrets or signatures).
Failure: the app is not listed (published under another team's token); install fails or hangs; the status stays `pending-handshake` past 2 minutes (the cron pod is not running, or it lacks the KMS key id or role; the container log shows no `/installed` line) (ChatDaddy could not reach `https://<host>/installed`: check the baseUrl, TLS and that the container is up). A 401 in the container for `/installed` means `CHATDADDY_PUBLIC_KEY` or `APP_ID` does not match.

## 4. Note the installation id

Copy the installation id from the installed app's page (or from the `installationId` the app received). Everything below uses it as `<id>`.

Check: the id is the same one that appears in your container's installation store entry (you never need to open the file).
Failure: using the app id or team id instead; step 5 then answers 404.

## 5. Give the app the shop's webhook secret

Copy the Shopify signing secret (Shopify admin, Settings, Notifications, Webhooks: "Your webhooks will be signed with ..."), then:

```
curl -X POST "https://<host>/installations/<id>/shopify-webhook-secret" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{ "secret": "<paste the shop signing secret>" }'
```

Check: `{"ok":true}`.
Failure: 401 wrong `ADMIN_TOKEN`; 404 unknown installation id (step 4 not done, or the app lost its volume); 400 secret not 8 to 256 printable characters without spaces.

## 6. Register the Shopify webhook

Shopify admin, Settings, Notifications, Webhooks, Create webhook: event `Order creation`, format `JSON`, URL `https://<host>/shopify/webhook/<id>`.

Check: the webhook is saved and listed.
Failure: Shopify refuses a non-HTTPS URL.

## 7. Build the flow

In the ChatDaddy flow builder create a flow:

1. Trigger: **Shopify order created** (from this app). Its payload has `orderId`, `customerName`, `phone`, `total`, `currency`, `itemsSummary`.
2. Step: **Format order message**. Map `orderId`, `customerName`, `total`, `currency`, `itemsSummary` from the trigger payload. Its output is `message`.
3. Step: a WhatsApp send, to the trigger's `phone`, with the formatted `message`.

Save and enable the flow.

Check: the trigger and the action appear in the builder (they come from the published manifest).
Failure: they are missing, so the installation is not on the version you published; the send step has no recipient, so `phone` was not mapped.

## 8. Fire a test order (sends a real WhatsApp message)

**This sends a real WhatsApp message to the order's phone number.** Create a Shopify test order whose customer phone is your own WhatsApp number. Shopify's "Send test notification" uses Shopify's sample order, which usually has a made-up or empty phone; with no phone the app acknowledges and skips it, so no flow runs. That still tests the signature (step below), but for the full path create a real test order.

Check, in order:
1. Shopify shows the webhook delivery as 200.
2. The container log has a line for `"route":"/shopify/webhook/:id"` with `"status":200`. Status 200 means the signature held and bots accepted the trigger; a 502 means bots refused it or was unreachable, and a 401 a bad signature.
3. The flow run appears in ChatDaddy and the WhatsApp message arrives with the formatted order text.

Failure:
- Shopify delivery 401: wrong secret (redo step 5 with the right store), wrong installation id in the URL, or the secret was never posted.
- Shopify delivery 502: ChatDaddy bots refused the trigger or was unreachable (check `CHATDADDY_BOTS_URL` and the installation's signing secret); Shopify will retry.
- Delivery 200 but no flow run: the order had no phone number or order number (skipped by design), or the flow is not enabled.
- Flow ran but no WhatsApp message: the send step's recipient or WhatsApp account is the problem, not this app.

## Not verified when this was written

This runbook was written from the appstore API and the app's code, not by clicking through the dashboard. The dashboard wording (where the apps list lives, how the installation id is shown, the flow builder labels) is the part to confirm on the first real run and correct here.
