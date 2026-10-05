// Mutation check: for each guard, apply a textual mutation to a source file,
// confirm the file really changed, run the suite, record which tests went red,
// then restore the file byte-for-byte. A mutation that leaves the suite green
// (or fails to apply) is reported and fails this script.
//   node scripts/mutation-check.mjs [name-substring]
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// `times`: how often `find` must occur; all of them are replaced
const M = (name, file, find, replace, times = 1) => ({ name, file, find, replace, times })

const MUTATIONS = [
	M('jwt: signature not checked', 'src/jwt.mjs', 'if(!ok) {', 'if(false) {'),
	M('jwt: exp not checked', 'src/jwt.mjs', "if(typeof payload.exp !== 'number' || payload.exp <= nowS) {", 'if(false) {'),
	M('jwt: header alg not checked', 'src/jwt.mjs', "if(header.alg !== 'ES256') {", 'if(false) {'),
	M('jwt: objectId not compared', 'src/jwt.mjs', 'meta.objectId === `app_${appId}/inst_${installationId}`', 'true'),
	M('jwt: token team not compared', 'src/jwt.mjs', '\n\t\t&& user.teamId === teamId', ''),
	M('jwt: metadata type not compared', 'src/jwt.mjs', "meta?.type === 'app'", 'true'),
	M('handshake: body appId not compared to own app id', 'src/server.mjs', 'body?.appId !== appId || ', ''),
	M('handshake: ack label changed', 'src/signing.mjs', "handshakeAck: 'chatdaddy/v1/handshake-ack'", "handshakeAck: 'chatdaddy/v1/handshake-nak'"),
	M('signing: bots-to-app label = app-to-bots label', 'src/signing.mjs', "botsToApp: 'chatdaddy/v1/bots-to-app'", "botsToApp: 'chatdaddy/v1/app-to-bots'"),
	M('signing: app-to-bots signs the bots-to-app content', 'src/signing.mjs', 'hmacHex(secret, appToBotsContent(timestampS, eventId, body))', 'hmacHex(secret, botsToAppContent(timestampS, body))'),
	M('signing: timestamp tolerance removed', 'src/signing.mjs', 'Math.abs(nowS - timestampS) > toleranceS', 'false'),
	M('signing: event id may contain dot', 'src/signing.mjs', '[\\x21-\\x2d\\x2f-\\x7e]', '[\\x21-\\x7e]'),
	M('action: signature not verified', 'src/server.mjs', "async function action(req, actionId) {\n\t\tconst raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)\n\t\tconst installationId = `${req.headers['x-chatdaddy-installation'] || ''}`\n\t\tconst secrets = store.secretsFor(installationId, now())\n\t\t// unknown installation, bad/missing/stale signature: one answer\n\t\tif(!secrets.length || !verifyBotsToApp(secrets, raw.toString('utf8'), req.headers['x-chatdaddy-signature'], now())) {", "async function action(req, actionId) {\n\t\tconst raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)\n\t\tconst installationId = `${req.headers['x-chatdaddy-installation'] || ''}`\n\t\tconst secrets = store.secretsFor(installationId, now())\n\t\t// unknown installation, bad/missing/stale signature: one answer\n\t\tif(!secrets.length) {"),
	M('action: secret not bound to the installation (last installed wins)', 'src/store.mjs', '\tsecretsFor(installationId, nowS) {\n\t\tconst rec = this.get(installationId)', '\tsecretsFor(installationId, nowS) {\n\t\tconst rec = Object.values(this.records).at(-1)'),
	M('action: unknown action resolves via prototype', 'src/server.mjs', 'Object.hasOwn(ACTIONS, actionId) ? ACTIONS[actionId] : undefined', 'ACTIONS[actionId]'),
	M('store: previous secret never expires', 'src/store.mjs', 'rec.previousSecretExpiresAt > nowS', 'true'),
	M('store: rotation does not keep the previous secret', 'src/store.mjs', 'if(prev && prev.signingSecret !== signingSecret) {', 'if(false) {'),
	M('store: repeat handshake drops an open window', 'src/store.mjs', '} else if(prev?.previousSecret) {', '} else if(false) {'),
	M('server: body size cap removed', 'src/server.mjs', 'if(size > limit) {', 'if(false) {'),
	M('shopify: HMAC over re-serialised JSON, not raw bytes', 'src/shopify.mjs', '.update(rawBody)', ".update(JSON.stringify(JSON.parse(rawBody.toString('utf8'))))"),
	M('shopify: event id random instead of webhook id', 'src/server.mjs', "const eventId = `${req.headers['x-shopify-webhook-id'] || ''}`", "const eventId = `${req.headers['x-shopify-webhook-id'] ? `r${Math.random().toString(36).slice(2)}` : ''}`"),
	M('shopify: webhook id format not validated', 'src/server.mjs', 'if(!isValidEventId(eventId)) {', 'if(false) {'),
	M('shopify: order without phone is forwarded', 'src/shopify.mjs', 'if(!orderId || !phone) {', 'if(!orderId) {'),
	M('shopify: bots non-2xx not surfaced', 'src/server.mjs', 'if(res.status < 200 || res.status >= 300) {', 'if(false) {'),
	M('shopify: itemsSummary not truncated', 'src/shopify.mjs', 'if(itemsSummary.length > ITEMS_SUMMARY_MAX) {', 'if(false) {'),
	// per-installation Shopify webhook secret
	M('webhook: signature not verified', 'src/server.mjs', 'const secret = known && verified ?', 'const secret = known ?'),
	M('webhook: secretless installation accepts the stand-in secret', 'src/server.mjs', 'const secret = known && verified ?', 'const secret = verified ?'),
	M('webhook: 401 carries detail', 'src/server.mjs', "if(!secret) {\n\t\t\tthrow new HttpError(401, 'unauthorized')", "if(!secret) {\n\t\t\tthrow new HttpError(401, 'unknown installation')"),
	M('webhook: compare is not constant-time', 'src/shopify.mjs', 'received.length === expected.length && timingSafeEqual(expected, received)', "received.toString('hex') === expected.toString('hex')"),
	M('webhook: secret taken from another installation (last set wins)', 'src/store.mjs', "const sealed = this.get(installationId)?.shopifyWebhookSecretSealed", "const sealed = Object.values(this.records).findLast(r => r.shopifyWebhookSecretSealed)?.shopifyWebhookSecretSealed"),
	M('seal: stored in the clear', 'src/store.mjs', 'shopifyWebhookSecretSealed: seal(this.sealKey, secret, installationId)', 'shopifyWebhookSecretSealed: secret'),
	M('seal: fixed IV', 'src/seal.mjs', 'const iv = randomBytes(12)', 'const iv = Buffer.alloc(12)'),
	M('seal: installation id not bound (AAD dropped)', 'src/seal.mjs', ".setAAD(Buffer.from(aad, 'utf8'))", '.setAAD(Buffer.alloc(0))', 2),
	M('seal: auth tag not checked on open', 'src/seal.mjs', 'decipher.setAuthTag(tag)', 'decipher.setAuthTag(tag); decipher.final = () => Buffer.alloc(0)'),
	M('seal: hex key length not enforced', 'src/seal.mjs', '/^[0-9a-fA-F]{64}$/.test(text)', '/^[0-9a-fA-F]+$/.test(text)'),
	M('secret: logged on set', 'src/server.mjs', 'await store.setWebhookSecret(installationId, secret)', 'console.log(secret); await store.setWebhookSecret(installationId, secret)'),
	M('secret: echoed by the config route', 'src/server.mjs', 'body: { ok: true } } // never echoes the secret', 'body: { ok: true, secret } }'),
	M('config: admin token not checked', 'src/server.mjs', 'if(!adminToken || !tokenEquals(adminToken, token)) {', 'if(false) {'),
	M('config: closed route opens when no token is configured', 'src/server.mjs', 'if(!adminToken || !tokenEquals(adminToken, token)) {', 'if(adminToken && !tokenEquals(adminToken, token)) {'),
	M('config: installation need not exist', 'src/server.mjs', 'if(!UUID.test(installationId) || !store.get(installationId)) {', 'if(false) {'),
	M('config: secret not validated', 'src/server.mjs', '|| !WEBHOOK_SECRET.test(secret)) {', ') {'),
	M('store: re-handshake wipes the webhook secret', 'src/store.mjs', 'if(prev?.shopifyWebhookSecretSealed) {', 'if(false) {'),
	M('uninstall: signature not verified', 'src/server.mjs', "if(!secrets.length || !verifyUninstalled(secrets, raw.toString('utf8'), req.headers['x-chatdaddy-signature'], now())) {", 'if(!secrets.length) {'),
	M('uninstall: deletes nothing', 'src/server.mjs', '\t\tawait store.deleteInstallation(installationId)\n', ''),
	M('uninstall: deleted in memory only, not persisted', 'src/store.mjs', 'await this.#commit(installationId, undefined)', 'delete this.records[installationId]'),
	M('uninstall: verified under the action label', 'src/server.mjs', '!verifyUninstalled(secrets', '!verifyBotsToApp(secrets'),
	M('uninstall: label equals the action label', 'src/signing.mjs', "uninstalled: 'chatdaddy/v1/uninstalled'", "uninstalled: 'chatdaddy/v1/bots-to-app'"),
	M('uninstall: event not required', 'src/server.mjs', "body?.event !== 'uninstalled' || ", ''),
	M('uninstall: body installation not compared to the header', 'src/server.mjs', ' || body.installationId !== installationId) {', ') {'),
	M('createApp: short admin token accepted', 'src/server.mjs', 'adminToken.length < ADMIN_TOKEN_MIN_LENGTH))', 'false))'),
	M('config: body read before the token is checked', 'src/server.mjs', "		const auth = req.headers.authorization || ''\n		const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''\n		if(!adminToken || !tokenEquals(adminToken, token)) {\n			throw new HttpError(401, 'unauthorized')\n		}\n\n		const raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)\n", "		const raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)\n		const auth = req.headers.authorization || ''\n		const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''\n		if(!adminToken || !tokenEquals(adminToken, token)) {\n			throw new HttpError(401, 'unauthorized')\n		}\n"),
]

function suite() {
	const files = spawnSync('sh', ['-c', 'ls test/*.test.mjs'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n')
	const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=15000', ...files], { cwd: root, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' })
	const failed = [...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1]).filter(n => !/\.test\.mjs$/.test(n))
	return { code: r.status, failed: [...new Set(failed)], pass: /# pass (\d+)/.exec(r.stdout)?.[1], fail: /# fail (\d+)/.exec(r.stdout)?.[1] }
}

const only = process.argv[2]
const base = suite()
if(base.code !== 0) {
	console.error('baseline suite is not green, aborting', base)
	process.exit(2)
}

console.log(`baseline: pass=${base.pass} fail=${base.fail}`)
let bad = 0
for(const m of MUTATIONS.filter(x => !only || x.name.includes(only))) {
	const path = root + m.file
	const original = readFileSync(path, 'utf8')
	const count = original.split(m.find).length - 1
	if(count !== m.times) {
		console.log(`NOT APPLIED  ${m.name}: pattern found ${count} times in ${m.file}, expected ${m.times}`)
		bad++
		continue
	}

	const mutated = original.replaceAll(m.find, () => m.replace)
	if(mutated === original) {
		console.log(`NOT APPLIED  ${m.name}: no change`)
		bad++
		continue
	}

	writeFileSync(path, mutated)
	let res
	try {
		res = suite()
	} finally {
		writeFileSync(path, original)
	}

	if(readFileSync(path, 'utf8') !== original) {
		throw new Error(`restore failed for ${m.file}`)
	}

	if(res.code === 0) {
		console.log(`SURVIVED     ${m.name}`)
		bad++
	} else {
		console.log(`RED (${res.fail})  ${m.name}\n      first: ${res.failed.slice(0, 3).join(' | ')}`)
	}
}

const after = suite()
console.log(`after restore: pass=${after.pass} fail=${after.fail}`)
process.exit(bad || after.code ? 1 : 0)
