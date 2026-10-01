// Mutation check: for each guard, apply a textual mutation to a source file,
// confirm the file really changed, run the suite, record which tests went red,
// then restore the file byte-for-byte. A mutation that leaves the suite green
// (or fails to apply) is reported and fails this script.
//   node scripts/mutation-check.mjs [name-substring]
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const M = (name, file, find, replace) => ({ name, file, find, replace })

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
	M('action: signature not verified', 'src/server.mjs', "if(!secrets.length || !verifyBotsToApp(secrets, raw.toString('utf8'), req.headers['x-chatdaddy-signature'], now())) {", 'if(!secrets.length) {'),
	M('action: secret not bound to the installation (last installed wins)', 'src/store.mjs', '\tsecretsFor(installationId, nowS) {\n\t\tconst rec = this.get(installationId)', '\tsecretsFor(installationId, nowS) {\n\t\tconst rec = Object.values(this.records).at(-1)'),
	M('action: unknown action resolves via prototype', 'src/server.mjs', 'Object.hasOwn(ACTIONS, actionId) ? ACTIONS[actionId] : undefined', 'ACTIONS[actionId]'),
	M('store: previous secret never expires', 'src/store.mjs', 'rec.previousSecretExpiresAt > nowS', 'true'),
	M('store: rotation does not keep the previous secret', 'src/store.mjs', 'if(prev && prev.signingSecret !== signingSecret) {', 'if(false) {'),
	M('store: repeat handshake drops an open window', 'src/store.mjs', '} else if(prev?.previousSecret) {', '} else if(false) {'),
	M('server: body size cap removed', 'src/server.mjs', 'if(size > limit) {', 'if(false) {'),
	M('shopify: HMAC not verified', 'src/server.mjs', "if(!verifyShopifyHmac(shopifyWebhookSecret, raw, req.headers['x-shopify-hmac-sha256'])) {", 'if(false) {'),
	M('shopify: HMAC over re-serialised JSON, not raw bytes', 'src/shopify.mjs', '.update(rawBody)', ".update(JSON.stringify(JSON.parse(rawBody.toString('utf8'))))"),
	M('shopify: event id random instead of webhook id', 'src/server.mjs', "const eventId = `${req.headers['x-shopify-webhook-id'] || ''}`", "const eventId = `${req.headers['x-shopify-webhook-id'] ? `r${Math.random().toString(36).slice(2)}` : ''}`"),
	M('shopify: webhook id format not validated', 'src/server.mjs', 'if(!isValidEventId(eventId)) {', 'if(false) {'),
	M('shopify: unknown installation falls back to a secret', 'src/server.mjs', 'const secret = UUID.test(installationId) ? store.currentSecret(installationId) : undefined', "const secret = store.currentSecret(installationId) || 'whsec_fallback'"),
	M('shopify: order without phone is forwarded', 'src/shopify.mjs', 'if(!orderId || !phone) {', 'if(!orderId) {'),
	M('shopify: bots non-2xx not surfaced', 'src/server.mjs', 'if(res.status < 200 || res.status >= 300) {', 'if(false) {'),
	M('shopify: itemsSummary not truncated', 'src/shopify.mjs', 'if(itemsSummary.length > ITEMS_SUMMARY_MAX) {', 'if(false) {'),
]

function suite() {
	const files = spawnSync('sh', ['-c', 'ls test/*.test.mjs'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n')
	const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, encoding: 'utf8' })
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
	if(count !== 1) {
		console.log(`NOT APPLIED  ${m.name}: pattern found ${count} times in ${m.file}`)
		bad++
		continue
	}

	const mutated = original.replace(m.find, () => m.replace)
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
