# {{APP_NAME}}

A ChatDaddy app scaffolded by `create-chatdaddy-app`. Node 22, plain ESM, no runtime dependencies.

## What is here

| File | What it does |
|---|---|
| `chatdaddy-app.json` | The manifest: scopes, handler, flow trigger `example-event`, flow action `shout`. Edit it first. |
| `src/server.mjs` | `POST /installed` (install handshake) and `POST /actions/:actionId` (a flow runs your action). |
| `src/actions.mjs` | The action handlers. One per `flowActions[].id` in the manifest. |
| `src/trigger.mjs` | `sendTrigger()`: fire a flow trigger from your own code. |
| `src/send-trigger.mjs` | The same from the command line. |
| `src/signing.mjs` | ChatDaddy's request signing. Leave it as it is; the tests pin its exact bytes. |
| `src/jwt.mjs` | Verifies the token ChatDaddy sends with the install handshake (ES256). |
| `src/keys.mjs` | Chooses the public key for that token. See "Keys" below. |
| `src/log.mjs` | One JSON line per log entry. Never log request bodies, tokens or signing secrets. |
| `src/store.mjs` | Remembers each installation's signing secret (a JSON file; protect it). |

## Run it

```
npm test            # unit tests for the server, signing, keys and trigger helper
npm start           # listens on $PORT (default 3000); production, ChatDaddy's real key
```

## Try it without a ChatDaddy account

`create-chatdaddy-app dev` stands in for ChatDaddy: it installs your app, calls your action with
a signed request, and receives the triggers your app sends. In one terminal:

```
npm run dev
```

In another, from this folder (use the path to the kit's `bin/create-chatdaddy-app.mjs` if you
have not installed the command):

```
create-chatdaddy-app dev --app http://localhost:3000
```

then at its prompt:

```
call shout --input '{"text":"hello"}'
```

To see your app fire a trigger, point it at the dev stand-in (default port 4100) and send one:

```
CHATDADDY_BOTS_URL=http://localhost:4100 node src/send-trigger.mjs example-event '{"message":"hi"}'
```

## Keys: development versus production

ChatDaddy proves an install is real by signing a token with its own private key; your app verifies
it with ChatDaddy's public key, which is built into `src/jwt.mjs`.
**Production always uses that key.**

For local testing only, the app can be told to trust the throwaway key that `create-chatdaddy-app dev` generates,
through `CHATDADDY_DEV_PUBLIC_KEY` (the PEM) or `CHATDADDY_DEV_PUBLIC_KEY_FILE` (a path, which `npm run dev` sets).
The app refuses to start if either is set while `NODE_ENV=production`. Set `NODE_ENV=production` on every real deployment.

## Before you publish

- Replace `developer`, `privacyPolicyUrl` and `handler.baseUrl` in `chatdaddy-app.json` (the example.com values are placeholders; `baseUrl` must be your public https URL).
- Request only the scopes you need.
- Run `create-chatdaddy-app validate`: it applies the same checks ChatDaddy runs when you publish.
