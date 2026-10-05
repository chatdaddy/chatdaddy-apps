// The mutation list for scripts/mutation-check.mjs: { name, file, find, replace }.
// `find` must occur exactly once in `file`. Every mutation disables one guard; the
// suite must go red for each. Paths are relative to packages/create-chatdaddy-app.
const M = (name, file, find, replace) => ({ name, file, find, replace })

const ENGINE = 'src/validate/engine.mjs'
const MANIFEST = 'src/validate/manifest.mjs'
const HOSTS = 'src/validate/hosts.mjs'
const SCHEMA = 'src/validate/schema.mjs'
const SIGNING = 'template/src/signing.mjs'
const JWT = 'template/src/jwt.mjs'
const SERVER = 'template/src/server.mjs'
const STORE = 'template/src/store.mjs'
const SESSION = 'src/dev/session.mjs'
const TRIGGER = 'src/dev/trigger-server.mjs'

export const MUTATIONS = [
	// ---- validator engine keywords ----
	M('engine: required not enforced', ENGINE, 'if(data[key] === undefined) {', 'if(false) {'),
	M('engine: properties not descended into', ENGINE, '\t\t\tif(data[key] !== undefined) {\n\t\t\t\tcheck(props[key]', '\t\t\tif(false) {\n\t\t\t\tcheck(props[key]'),
	M('engine: additionalProperties:false not enforced', ENGINE, 'fail(`must NOT have additional properties ("${key}")`)', 'void 0'),
	M('engine: type not enforced', ENGINE, 'if(!types.some(t => TYPE_CHECKS[t]?.(data))) {', 'if(false) {'),
	M('engine: const not enforced', ENGINE, "if('const' in schema && !deepEqual(schema.const, data)) {", 'if(false) {'),
	M('engine: enum not enforced', ENGINE, 'if(schema.enum && !schema.enum.some(', 'if(false && !schema.enum.some('),
	M('engine: pattern not enforced', ENGINE, "!new RegExp(schema.pattern, 'u').test(data)", 'false'),
	M('engine: maxLength not enforced', ENGINE, 'codePoints(data) > schema.maxLength', 'false'),
	M('engine: minLength not enforced', ENGINE, 'codePoints(data) < schema.minLength', 'false'),
	M('engine: maxLength counts UTF-16 units, not code points', ENGINE, 'const codePoints = s => [...s].length', 'const codePoints = s => s.length'),
	M('engine: minItems not enforced', ENGINE, 'data.length < schema.minItems', 'false'),
	M('engine: items not validated', ENGINE, '\t\tif(schema.items) {', '\t\tif(false) {'),
	M('engine: format not enforced', ENGINE, 'FORMATS[schema.format] && !FORMATS[schema.format](data)', 'false'),
	M('engine: oneOf accepts several matches', ENGINE, 'if(passing !== 1) {', 'if(passing === 0) {'),
	M('engine: oneOf accepts no match', ENGINE, 'if(passing !== 1) {', 'if(passing > 1) {'),
	M('engine: allOf ignored', ENGINE, 'for(const sub of schema.allOf || []) {', 'for(const sub of []) {'),
	M('engine: if/then ignored', ENGINE, 'if(scratch.length === 0 && schema.then) {', 'if(false) {'),
	M('engine: $ref not followed', ENGINE, 'if(schema.$ref !== undefined) {', 'if(false) {'),
	M('engine: arrays compared by length only', ENGINE, 'return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))', 'return a.length === b.length'),
	M('engine: objects compared by key count only', ENGINE, 'return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))', 'return ka.length === Object.keys(b).length'),

	// ---- schema ----
	M('schema: https-only pattern removed', SCHEMA, "\tpattern: '^https://',\n", ''),
	M('schema: at-least-one scope removed', SCHEMA, "scopes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },", "scopes: { type: 'array', items: { type: 'string', minLength: 1 } },"),
	M('schema: connection hosts may be empty', SCHEMA, "hosts: { type: 'array', minItems: 1,", "hosts: { type: 'array',"),
	M('schema: aiUse accepts anything listed extra', SCHEMA, "enum: ['none', 'task-bound']", "enum: ['none', 'task-bound', 'always']"),
	M('schema: id pattern allows double hyphens', SCHEMA, "const idPattern = '^[a-z0-9]+(-[a-z0-9]+)*$'", "const idPattern = '^[a-z0-9-]+$'"),
	M('schema: array property no longer needs items', SCHEMA, "then: { required: ['items'] },", 'then: {},'),
	M('schema: manifestVersion not pinned', SCHEMA, 'manifestVersion: { const: 1 },', 'manifestVersion: {},'),

	// ---- semantic rules ----
	M('manifest: unknown scope accepted', MANIFEST, '!KNOWN_SCOPES.has(scope)', 'false'),
	M('manifest: non-appGrantable scope accepted', MANIFEST, '!APP_GRANTABLE_SCOPES.has(scope)', 'false'),
	M('manifest: unknown event accepted', MANIFEST, '!KNOWN_EVENT_NAMES.has(event)', 'false'),
	M('manifest: duplicates never reported', MANIFEST, 'if(seen.has(value)) {', 'if(false) {'),
	M('manifest: private hosts accepted', MANIFEST, 'if(isPrivateOrLoopbackHost(value)) {', 'if(false) {'),
	M('manifest: handler baseUrl not host-checked', MANIFEST, "if(m.handler?.type === 'url') {", 'if(false) {'),
	M('manifest: connection hosts not host-checked', MANIFEST, 'for(const [j, host] of asArray(connection.hosts).entries()) {', 'for(const [j, host] of [].entries()) {'),
	M('manifest: developer.url not host-checked', MANIFEST, "{ path: '/developer/url', value: m.developer?.url },", ''),
	M('manifest: duplicate connection ids unchecked', MANIFEST, 'if(Array.isArray(m.connections)) {\n\t\tpushDuplicates', 'if(false) {\n\t\tpushDuplicates'),
	M('manifest: duplicate flowAction ids unchecked', MANIFEST, 'if(Array.isArray(m.flowActions)) {\n\t\tpushDuplicates', 'if(false) {\n\t\tpushDuplicates'),
	M('manifest: duplicate flowTrigger ids unchecked', MANIFEST, 'if(Array.isArray(m.flowTriggers)) {', 'if(false) {'),
	M('manifest: duplicate template ids unchecked', MANIFEST, 'if(Array.isArray(m.templates)) {', 'if(false) {'),
	M('manifest: duplicate settings unchecked', MANIFEST, 'if(Array.isArray(m.settings)) {', 'if(false) {'),
	M('manifest: duplicate inputProperties unchecked', MANIFEST, 'if(Array.isArray(action.inputProperties)) {', 'if(false) {'),
	M('manifest: duplicate outputProperties unchecked', MANIFEST, 'if(Array.isArray(action.outputProperties)) {', 'if(false) {'),
	M('manifest: layers not combined (semantic errors dropped when schema fails)', MANIFEST, 'const schemaValid = errors.length === 0\n', 'const schemaValid = errors.length === 0\n\tif(!schemaValid) {\n\t\treturn { valid: false, errors }\n\t}\n'),
	M('manifest: valid ignores semantic errors', MANIFEST, 'valid: schemaValid && errors.length === 0', 'valid: schemaValid'),

	// ---- host classification ----
	M('hosts: 10/8 not private', HOSTS, 'a === 10 // 10.0.0.0/8', 'false // 10.0.0.0/8'),
	M('hosts: 172.16/12 upper bound off by one', HOSTS, 'b >= 16 && b <= 31', 'b >= 16 && b <= 30'),
	M('hosts: 192.168/16 not private', HOSTS, '(a === 192 && b === 168)', 'false'),
	M('hosts: 127/8 not private', HOSTS, '|| a === 127 // 127.0.0.0/8 loopback', '|| false'),
	M('hosts: link-local 169.254 not private', HOSTS, '|| (a === 169 && b === 254)', '|| false'),
	M('hosts: 0/8 not private', HOSTS, '|| a === 0 // 0.0.0.0/8', '|| false'),
	M('hosts: localhost name not private', HOSTS, "new Set(['localhost', '0.0.0.0', '::1', '::'])", "new Set(['0.0.0.0', '::1', '::'])"),
	M('hosts: trailing dot not stripped', HOSTS, ".toLowerCase().replace(/\\.+$/, '')", '.toLowerCase()'),
	M('hosts: .local suffix not private', HOSTS, "hostname.endsWith('.local') || ", ''),
	M('hosts: IPv6 unique-local/link-local not private', HOSTS, 'return /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)', 'return false'),
	M('hosts: IPv4-mapped IPv6 hex form not unwrapped', HOSTS, 'const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)', 'const hex = null'),

	// ---- signing (byte-for-byte contract) ----
	M('signing: handshake ack label changed', SIGNING, "handshakeAck: 'chatdaddy/v1/handshake-ack'", "handshakeAck: 'chatdaddy/v1/handshake-nak'"),
	M('signing: bots-to-app label = app-to-bots label', SIGNING, "botsToApp: 'chatdaddy/v1/bots-to-app'", "botsToApp: 'chatdaddy/v1/app-to-bots'"),
	M('signing: app-to-bots label changed', SIGNING, "appToBots: 'chatdaddy/v1/app-to-bots'", "appToBots: 'chatdaddy/v1/app-to-bot'"),
	M('signing: app-to-bots signs the bots-to-app content', SIGNING, 'hmacHex(secret, appToBotsContent(timestampS, eventId, body))', 'hmacHex(secret, botsToAppContent(timestampS, body))'),
	M('signing: app-to-bots not bound to the event id', SIGNING, '`${APP_SIGNING_LABELS.appToBots}.${t}.${eventId}.${body}`', '`${APP_SIGNING_LABELS.appToBots}.${t}..${body}`'),
	M('signing: timestamp tolerance removed', SIGNING, 'Math.abs(nowS - timestampS) > toleranceS', 'false'),
	M('signing: tolerance widened', SIGNING, 'APP_SIGNATURE_TOLERANCE_S = 5 * 60', 'APP_SIGNATURE_TOLERANCE_S = 10 * 60'),
	M('signing: event id may contain a dot', SIGNING, '[\\x21-\\x2d\\x2f-\\x7e]', '[\\x21-\\x7e]'),
	M('signing: event id length cap removed', SIGNING, '{1,128}$/', '{1,}$/'),
	M('signing: header parse accepts extra parts', SIGNING, 'if(parts.length !== 2) {', 'if(parts.length < 2) {'),
	M('signing: header hex may be upper case', SIGNING, '/^[0-9a-f]{64}$/.test(map.v1', '/^[0-9a-fA-F]{64}$/.test(map.v1'),
	M('signing: only the first secret is tried', SIGNING, 'for(const secret of Array.isArray(secrets) ? secrets : [secrets]) {', 'for(const secret of (Array.isArray(secrets) ? secrets : [secrets]).slice(0, 1)) {'),

	// ---- handshake token (scaffolded app) ----
	M('jwt: signature not checked', JWT, 'if(!ok) {', 'if(false) {'),
	M('jwt: exp not checked', JWT, "if(typeof payload.exp !== 'number' || payload.exp <= nowS) {", 'if(false) {'),
	M('jwt: header alg not checked', JWT, "if(header.alg !== 'ES256') {", 'if(false) {'),
	M('jwt: objectId not compared', JWT, 'meta.objectId === `app_${appId}/inst_${installationId}`', 'true'),
	M('jwt: token team not compared', JWT, '\n\t\t&& user.teamId === teamId', ''),
	M('jwt: metadata type not compared', JWT, "meta?.type === 'app'", 'true'),
	M('server: body appId not compared to own app id', SERVER, 'body?.appId !== appId || ', ''),
	M('server: action signature not verified', SERVER, "if(!secrets.length || !verifyBotsToApp(secrets, raw.toString('utf8'), req.headers['x-chatdaddy-signature'], now())) {", 'if(!secrets.length) {'),
	M('server: unknown action resolves via prototype', SERVER, 'Object.hasOwn(ACTIONS, actionId) ? ACTIONS[actionId] : undefined', 'ACTIONS[actionId]'),
	M('server: body size cap removed', SERVER, 'if(size > limit) {', 'if(false) {'),
	M('server: installation in context not compared', SERVER, 'body.context.installationId !== installationId', 'false'),
	M('server: handshake body not validated', SERVER, "typeof signingSecret !== 'string' || !signingSecret", 'false'),
	M('store: secret not bound to the installation (last installed wins)', STORE, '\tsecretsFor(installationId, nowS) {\n\t\tconst rec = this.get(installationId)', '\tsecretsFor(installationId, nowS) {\n\t\tconst rec = Object.values(this.records).at(-1)'),
	M('store: previous secret never expires', STORE, 'rec.previousSecretExpiresAt > nowS', 'true'),
	M('store: rotation does not keep the previous secret', STORE, 'if(prev && prev.signingSecret !== signingSecret) {', 'if(false) {'),
	M('store: repeat handshake drops an open window', STORE, '} else if(prev?.previousSecret) {', '} else if(false) {'),
	M('store: prototype names resolve as installations', STORE, 'Object.hasOwn(this.records, installationId) ? this.records[installationId] : undefined', 'this.records[installationId]'),
	M('store: file written world-readable', STORE, '{ mode: 0o600 }', '{ mode: 0o644 }'),

	// ---- dev key production switch ----
	M('keys: dev key accepted under NODE_ENV=production', 'template/src/keys.mjs', "env.NODE_ENV === 'production'", 'false'),
	M('keys: production check compares a different value', 'template/src/keys.mjs', "env.NODE_ENV === 'production'", "env.NODE_ENV === 'prod'"),
	M('keys: dev key file form not covered by the production refusal', 'template/src/keys.mjs', 'if(!inline && !file) {\n\t\treturn () => CHATDADDY_PUBLIC_KEY\n\t}', 'if(!inline) {\n\t\treturn () => CHATDADDY_PUBLIC_KEY\n\t}'),
	M('keys: both dev key forms allowed together', 'template/src/keys.mjs', 'if(inline && file) {', 'if(false) {'),
	M('keys: dev key file read once, not per handshake', 'template/src/keys.mjs', 'return () => inline || readFileSync(file, \'utf8\')', 'const once = inline || readFileSync(file, \'utf8\')\n\treturn () => once'),
	M('keys: main.mjs does not stop on the refusal', 'template/src/main.mjs', "\tlog('error', err.message)\n\tprocess.exit(1)", "\tlog('error', err.message)"),

	// ---- hardening (scaffold) ----
	M('server: declared content-length over the cap not refused up front', SERVER, "if(Number(req.headers['content-length']) > limit) {", 'if(false) {'),
	M('server: body timeout removed', SERVER, 'const timer = setTimeout(() => req.destroy(', 'const timer = setTimeout(() => void (', ),
	M('server: 413 does not close the connection', SERVER, "...(out.status === 413 ? { connection: 'close' } : {}),", ''),
	M('server: action id not checked against the slug pattern', SERVER, 'if(!ACTION_ID.test(actionId)) {', 'if(false) {'),
	M('store: failed write leaves the queue rejected', STORE, 'this.queue = write.catch(() => undefined)', 'this.queue = write'),
	M('store: failed write is swallowed', STORE, 'return write\n', 'return write.catch(() => undefined)\n'),
	M('store: failed write does not roll the record back', STORE, '\t\t\tif(prev) {\n\t\t\t\tthis.records[installationId] = prev', '\t\t\tif(false) {\n\t\t\t\tthis.records[installationId] = prev'),
	M('store: failed first write leaves a record behind', STORE, '\t\t\t\tdelete this.records[installationId]', '\t\t\t\tvoid 0'),
	M('log: unexpected errors not logged', SERVER, "log('error', 'unexpected error', { error: err?.message })", 'void 0'),

	// ---- trigger sender (scaffold) ----
	M('trigger: sender does not sign', 'template/src/trigger.mjs', "'x-chatdaddy-signature': signAppToBots(secret, eventId, body, now),", "'x-chatdaddy-signature': 't=1,v1=00',"),
	M('trigger: sender does not cap the payload', 'template/src/trigger.mjs', 'if(Buffer.byteLength(body) > MAX_TRIGGER_BODY_BYTES) {', 'if(false) {'),

	// ---- dev: the ChatDaddy stand-in ----
	M('dev: handshake ack not verified', SESSION, 'if(ack !== computeHandshakeAck(session.signingSecret, nonce)) {', 'if(false) {'),
	M('dev: handshake non-200 accepted', SESSION, 'if(res.status !== 200) {', 'if(false) {'),
	M('dev: action call signed over a different body', SESSION, 'signBotsToApp(session.signingSecret, body, now())', "signBotsToApp(session.signingSecret, `${body} `, now())"),
	M('dev: action response not checked against outputProperties', SESSION, "const out = checkProperties(action.outputProperties, parsed, 'output')", "const out = { problems: [], warnings: [] }"),
	M('dev: install token names the wrong installation', SESSION, 'objectId: `app_${appId}/inst_${installationId}`', 'objectId: `app_${appId}/inst_x`'),
	M('dev: install token not signed with the dev key', SESSION, "sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' })", "sign('sha256', Buffer.from(`${data}x`), { key: privateKey, dsaEncoding: 'ieee-p1363' })"),
	M('dev: trigger signature not verified', TRIGGER, "if(!verifyAppToBots(session.signingSecret, eventId, raw, req.headers['x-chatdaddy-signature'], now())) {", 'if(false) {'),
	M('dev: trigger event id not validated', TRIGGER, 'if(!isValidEventId(eventId)) {', 'if(false) {'),
	M('dev: trigger payloadSchema not enforced', TRIGGER, 'if(errors.length) {', 'if(false) {'),
	M('dev: duplicate event ids fire twice', TRIGGER, 'if(seen.has(key)) {', 'if(false) {'),
	M('dev: trigger installation not checked', TRIGGER, 'if(installationId !== session.installationId) {', 'if(false) {'),
	M('dev: undeclared trigger accepted', TRIGGER, 'if(!trigger) {', 'if(false) {'),
	M('dev: trigger body cap removed', TRIGGER, 'if(size > MAX_TRIGGER_BODY_BYTES) {', 'if(false) {'),
	M('dev: non-object trigger body accepted', TRIGGER, "if(payload === null || typeof payload !== 'object' || Array.isArray(payload)) {", 'if(false) {'),
	M('dev: not-installed trigger accepted', TRIGGER, 'if(!session.installed) {', 'if(false) {'),

	// ---- init ----
	M('init: non-empty directory overwritten', 'src/init.mjs', 'if(readdirSync(target).length > 0) {', 'if(false) {'),
	M('init: existing file path not refused', 'src/init.mjs', 'if(!statSync(target).isDirectory()) {', 'if(false) {'),
	M('init: name not checked', 'src/init.mjs', "if(!appName || appName.length > 128 || !appId) {", 'if(false) {'),
	M('init: JSON values not escaped', 'src/init.mjs', "rel.endsWith('.json') ? s => JSON.stringify(s).slice(1, -1) : s => s", 's => s'),
	M('init: id not truncated to 64', 'src/init.mjs', '.slice(0, 64)', ''),
	M('init: gitignore not renamed', 'src/init.mjs', "{ gitignore: '.gitignore' }", '{}'),
	M('cli: init failure exits 0', 'src/cli.mjs', "stderr(`error: ${err.message}`)\n\t\t\treturn 1", "stderr(`error: ${err.message}`)\n\t\t\treturn 0"),
	M('cli: validate failure exits 0', 'src/cli.mjs', '\t\t\treturn 1\n\t\t}\n\n\t\tif(command === \'dev\') {', '\t\t\treturn 0\n\t\t}\n\n\t\tif(command === \'dev\') {'),
]
