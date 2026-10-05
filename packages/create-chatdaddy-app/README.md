# create-chatdaddy-app

The builder kit for ChatDaddy apps. Three commands, no runtime dependencies, Node 22+.

| Command | What it does |
|---|---|
| `init <dir>` | Scaffold a small, working app: manifest, server, one action, one trigger, tests. |
| `validate [manifest.json]` | Check a manifest exactly as ChatDaddy does when you publish it. |
| `dev` | Stand in for ChatDaddy on your machine: install your app, call its actions, receive its triggers. No account needed. |

## Getting it

The package is not on npm. Run it from a clone of this repository:

```
git clone https://github.com/chatdaddy/chatdaddy-apps.git
node chatdaddy-apps/packages/create-chatdaddy-app/bin/create-chatdaddy-app.mjs --help
```

To get a `create-chatdaddy-app` command on your PATH, link it (the package has no dependencies, so this installs nothing):

```
cd chatdaddy-apps/packages/create-chatdaddy-app && npm link
```

Or run it straight from GitHub without cloning (the repository's root `package.json` exposes the same command):

```
npx github:chatdaddy/chatdaddy-apps#main init my-app --name "My App"
```

The examples below write `create-chatdaddy-app`; substitute `node <clone>/packages/create-chatdaddy-app/bin/create-chatdaddy-app.mjs` if you did not link it.

## Start a new app

```
create-chatdaddy-app init my-app --name "My App"
cd my-app
npm test
```

`init` refuses a directory that already has anything in it, so it can never overwrite your work.
The app id (`my-app`) is the name as a slug; it must stay stable once published.

The scaffold contains:

- `chatdaddy-app.json`: one flow trigger (`example-event`, with a `payloadSchema`), one flow action (`shout`, with `inputProperties` and `outputProperties`), one scope, and the handler `{ "type": "url", "baseUrl": "https://example.com" }`. Replace the placeholders before you publish.
- `src/server.mjs`: `POST /installed` (the install handshake) and `POST /actions/:actionId`.
- `src/trigger.mjs`, `src/send-trigger.mjs`: fire a trigger from code or the command line.
- `src/signing.mjs`, `src/jwt.mjs`: the byte-exact request signing and the handshake token check. Leave these alone.
- `test/`: tests for all of it, run with `npm test`.

## validate

```
create-chatdaddy-app validate                 # ./chatdaddy-app.json
create-chatdaddy-app validate path/to/manifest.json
```

Exit code 0 if valid, 1 if not (every problem is listed), 2 if the file is missing or not JSON.

It is a dependency-free port of ChatDaddy's publish-time validation: the same two layers.

1. **JSON Schema (draft-07)**: shapes, required fields, lengths, patterns, `https://` URLs, enums.
2. **Semantic checks**: scope names must exist **and be app-grantable**, `eventSubscriptions` must be real event names, ids must be unique inside each array, and URLs and hosts must not be private or loopback (so `http://localhost` is rejected at publish; use `dev` for local testing). At least one scope is required.
3. **Connections** (`connections[]`): the rules live in `src/validate/connections.mjs`, which is the source of truth; in short:
   - An `apiKey` connection needs a `headerName` and may set a `headerPrefix` (printable ASCII only). An `oauth2` one needs `authUrl` and `tokenUrl`, and the hosts of those two URLs must be listed in `hosts` as exact hosts.
   - **Exact hosts** must be bare lowercase hostnames that `new URL()` leaves unchanged: no port, path, `user@`, wildcard, upper case or trailing dot, and never an IP address in any form (`127.0.0.1`, `127.1`, `2130706433`, `[::1]`).
   - `hosts` may also hold **one host template**, `{<inputId>}.<suffix>`. The placeholder is the whole leftmost label and names an entry of `inputs[]` (at most 3). The suffix needs at least two lowercase ASCII labels, a last label that is not all digits, and must survive `new URL()` unchanged. It must not be a public suffix from the vendored Public Suffix List (`co.uk`, `github.io`, `herokuapp.com` and so on), except the provider tenant domains in `TENANT_SUFFIX_ALLOWLIST` (`myshopify.com`), so `{shop}.myshopify.com` works.
   - `headerName` and `forwardHeaders[]` must be valid header names and may not be any of `DENIED_HEADERS` / `DENIED_HEADER_PREFIXES`: `host`, `cookie`, `set-cookie`, `connection`, `keep-alive`, `transfer-encoding`, `content-length`, `te`, `upgrade`, `expect`, `forwarded`, `via`, `x-real-ip`, `x-original-url`, `x-rewrite-url`, `x-http-method-override`, `x-http-method`, `x-method-override`, `proxy-*` and `x-forwarded-*`. `authorization` is allowed only as the connection's own `headerName`.
   - An input's `pattern` is advisory (it must compile and be at most 200 characters); the server enforces its own label rule, which `isValidHostLabel` in `src/validate/hosts.mjs` implements.

The scope and event lists are a snapshot of the public [`chatdaddy/typescript-client`](https://github.com/chatdaddy/typescript-client).
They are only as current as the last sync; if ChatDaddy adds a scope you cannot yet use here, regenerate them:

```
node scripts/sync-scopes.mjs               # from GitHub, branch main
node scripts/sync-scopes.mjs --local <path to a typescript-client clone>
```

The public suffix check uses a snapshot of the [Public Suffix List](https://publicsuffix.org/list/) (ICANN and private sections), `src/data/public-suffix.json`:

```
node scripts/sync-public-suffix.mjs                  # from publicsuffix.org
node scripts/sync-public-suffix.mjs --local <path to public_suffix_list.dat>
```

The JSON Schema keywords the validator implements are exactly the ones the manifest schema uses:
`$ref` (local), `type`, `const`, `enum`, `pattern`, `minLength`, `maxLength`, `minItems`, `maxItems`, `required`, `properties`,
`additionalProperties`, `items`, `oneOf`, `allOf`, `if`/`then`, and `format` (`uri`, `email`).

## dev: ChatDaddy on your laptop

`dev` plays ChatDaddy. It generates a throwaway ES256 key pair, installs your app (the same `POST /installed` handshake, with a
token signed by that key), checks your app's acknowledgement, and then lets you call actions and receive triggers.

1. In your app's directory, start the app so that it trusts the dev key. The scaffold's `npm run dev` does it:

   ```
   npm run dev
   ```

   which is `CHATDADDY_DEV_PUBLIC_KEY_FILE=.chatdaddy-dev/public-key.pem node src/main.mjs`.
2. In a second terminal, in the same directory:

   ```
   create-chatdaddy-app dev --app http://localhost:3000
   ```

   It writes the **public** key to `.chatdaddy-dev/public-key.pem` (the private key stays in memory, new on every run), starts a local trigger
   endpoint (default port 4100), installs the app, and gives you a prompt.

At the prompt:

```
call shout --input '{"text":"hello"}'      # a signed request to POST /actions/shout; the reply is checked against outputProperties
handshake                                   # install again, e.g. after restarting the app
triggers                                    # what your app has fired so far
help | quit
```

Commands are read one per line, so it also works piped: `echo "call shout --input '{\"text\":\"hi\"}'" | create-chatdaddy-app dev`.

To see your app fire a trigger, point it at the local endpoint and send one:

```
CHATDADDY_BOTS_URL=http://localhost:4100 node src/send-trigger.mjs example-event '{"message":"hi"}'
```

The local endpoint (`POST /apps/triggers/{installationId}/{triggerId}`) verifies the same things ChatDaddy does: the installation, that the trigger
is declared in the manifest, the event id, the app-to-bots signature over the exact body (bound to the event id, within 300 seconds), the 64 KB limit,
and that the body is a JSON object satisfying the trigger's `payloadSchema`. Then it prints `WOULD FIRE ...`. A repeated event id is acknowledged but
not fired again. Flags: `--app`, `--manifest`, `--port` (0 for any free port), `--key-file`.

What `dev` is not: it does not run flows, does not mint real scopes, and its response bodies are approximations of ChatDaddy's.
It checks your app's half of the contract, not ChatDaddy's.

### Keys: development versus production

ChatDaddy proves an install is real by signing a token with its own private key. Your app verifies it with ChatDaddy's public key.
**Production always uses ChatDaddy's real public key** (built into the scaffold's `src/jwt.mjs`).

The dev key is a local-testing exception, and the scaffold enforces it in `src/keys.mjs`:

- `CHATDADDY_DEV_PUBLIC_KEY` (the PEM) or `CHATDADDY_DEV_PUBLIC_KEY_FILE` (a path, re-read on every handshake) makes the app trust the dev key **instead of** ChatDaddy's.
- If either is set while `NODE_ENV=production`, the app **refuses to start**. It never quietly trusts a key anyone can generate.
- `NODE_ENV` unset counts as "not production". Set `NODE_ENV=production` on every real deployment.

If you write your app without the scaffold, copy this rule: accept a dev key only when `NODE_ENV !== 'production'`.

## Tests and mutation check

```
npm test                  # from this directory: node --test test/*.test.mjs
node scripts/mutation-check.mjs [--backup <dir>] [name-filter]
```

The tests cover every command: `init` produces a tree whose own tests pass, `validate` runs every ported ChatDaddy fixture, and `dev` does a full
handshake, action call and trigger delivery against the scaffolded app in-process. The signing tests pin vectors generated by ChatDaddy's own signing code.

The mutation check backs the sources up (and confirms the backup by hash), then for each guard (validator rules, signature checks, the dev-key
production switch, `init`'s overwrite refusal and more) disables it, requires the suite to go red, restores the file, and finally diffs the tree against the backup.
