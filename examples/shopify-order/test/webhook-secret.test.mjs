import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseSealKey, seal, unseal } from '../src/seal.mjs'
import { signBotsToApp, signUninstalled } from '../src/signing.mjs'
import { InstallationStore } from '../src/store.mjs'
import {
	ADMIN_TOKEN, INST_A, INST_B, SAMPLE_ORDER, SEAL_KEY, SHOPIFY_SECRET_A, SHOPIFY_SECRET_B, shopifyHmac, startApp,
} from './helpers.mjs'

const SIGNING_A = 'whsec_chatdaddy_signing_A'
const SIGNING_B = 'whsec_chatdaddy_signing_B'
const RAW = JSON.stringify(SAMPLE_ORDER)
const SECRETS = [SHOPIFY_SECRET_A, SHOPIFY_SECRET_B, SIGNING_A, SIGNING_B]

/** two installed stores, each with its own Shopify webhook secret */
async function setup(overrides) {
	const app = await startApp(overrides)
	await app.handshake(SIGNING_A, { installationId: INST_A })
	await app.handshake(SIGNING_B, { installationId: INST_B, nonce: 'n-2' })
	assert.equal((await app.setWebhookSecret(INST_A, SHOPIFY_SECRET_A)).status, 200)
	assert.equal((await app.setWebhookSecret(INST_B, SHOPIFY_SECRET_B)).status, 200)
	const hook = (inst, secret, raw = RAW, extra = {}) => app.post(`/shopify/webhook/${inst}`, raw, {
		'x-shopify-hmac-sha256': shopifyHmac(secret, raw), 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': 'wh-1', ...extra,
	})
	const notice = inst => JSON.stringify({ event: 'uninstalled', installationId: inst, teamId: 'team-1', appId: 'shopify-order-whatsapp' })
	const uninstall = (inst, signWith, body = notice(inst)) => app.post('/uninstalled', body, {
		'x-chatdaddy-installation': inst, 'x-chatdaddy-signature': signUninstalled(signWith, body, app.clock.t),
	})
	return { app, hook, uninstall, notice }
}

test('each store verifies with its own secret and is forwarded under its own installation', async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 200)
		assert.equal((await hook(INST_B, SHOPIFY_SECRET_B)).status, 200)
		assert.deepEqual(app.calls.map(c => c.url.split('/').slice(-2)[0]), [INST_A, INST_B])
	} finally {
		await app.close()
	}
})

test("another store's secret does not verify: A's secret on B's URL and B's on A's -> 401, nothing sent", async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await hook(INST_B, SHOPIFY_SECRET_A)).status, 401)
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_B)).status, 401)
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})

test('unknown, malformed, or secretless installation -> the same bare 401, nothing sent', async() => {
	const { app, hook } = await setup()
	try {
		const INST_C = '33333333-3333-4333-8333-333333333333'
		await app.handshake('whsec_c', { installationId: INST_C, nonce: 'n-3' }) // installed, but no webhook secret yet
		const bad = await hook(INST_A, SHOPIFY_SECRET_B)
		const results = [
			bad,
			await hook('44444444-4444-4444-8444-444444444444', SHOPIFY_SECRET_A),
			await hook('not-a-uuid', SHOPIFY_SECRET_A),
			await hook(INST_C, SHOPIFY_SECRET_A),
			await hook(INST_C, ''),
			await hook(INST_C, 'unconfigured-installation-placeholder'), // the stand-in secret never opens a secretless installation
			await app.post(`/shopify/webhook/${INST_A}`, RAW, { 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': 'wh-1' }), // no signature header
		]
		for(const r of results) {
			assert.equal(r.status, 401)
			assert.equal(r.text, bad.text)
		}

		assert.deepEqual(bad.json, { error: 'unauthorized' })
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})

test('a tampered body -> 401, nothing sent', async() => {
	const { app, hook } = await setup()
	try {
		const signedForOriginal = shopifyHmac(SHOPIFY_SECRET_A, RAW)
		const tampered = RAW.replace('1001', '1002')
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A, tampered, { 'x-shopify-hmac-sha256': signedForOriginal })).status, 401)
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})

test('webhook verification is constant-time: the compare is timingSafeEqual over equal-length buffers', async() => {
	const src = await readFile(fileURLToPath(new URL('../src/shopify.mjs', import.meta.url)), 'utf8')
	assert.match(src, /timingSafeEqual\(expected, received\)/)
	assert.doesNotMatch(src, /===\s*header|header\s*===/)
})

test('the secrets never appear in any response, in stdout/stderr/console, or in plaintext on disk', async() => {
	const dir = await mkdtemp(join(tmpdir(), 'wh-'))
	const seen = []
	const realOut = process.stdout.write.bind(process.stdout)
	const realErr = process.stderr.write.bind(process.stderr)
	const patch = real => (chunk, ...rest) => {
		seen.push(String(chunk))
		return real(chunk, ...rest)
	}

	const consoleKeys = ['log', 'info', 'warn', 'error', 'debug']
	const realConsole = Object.fromEntries(consoleKeys.map(k => [k, console[k]]))
	const store = await new InstallationStore(join(dir, 'installations.json'), { sealKey: SEAL_KEY }).load()
	const { app, hook, uninstall } = await setup({ store })
	process.stdout.write = patch(realOut)
	process.stderr.write = patch(realErr)
	for(const k of consoleKeys) {
		console[k] = (...a) => seen.push(a.map(String).join(' '))
	}

	try {
		const responses = [
			await hook(INST_A, SHOPIFY_SECRET_A), await hook(INST_A, SHOPIFY_SECRET_B), await hook('nope', SHOPIFY_SECRET_A),
			await app.setWebhookSecret(INST_A, 'a-brand-new-secret-value'), await app.setWebhookSecret(INST_A, 'x'),
			await app.setWebhookSecret(INST_A, SHOPIFY_SECRET_A, 'wrong-token'),
			await app.setWebhookSecret('not-a-uuid', SHOPIFY_SECRET_A),
			await app.post(`/installations/${INST_A}/shopify-webhook-secret`, '{not json', { authorization: `Bearer ${ADMIN_TOKEN}` }),
			await app.post('/actions/format-order-message', '{}', { 'x-chatdaddy-installation': INST_A }),
			await uninstall(INST_A, 'wrong'),
			await fetch(`${app.base}/healthz`).then(async r => ({ text: await r.text() })),
		]
		for(const r of responses) {
			for(const s of [...SECRETS, 'a-brand-new-secret-value', ADMIN_TOKEN]) {
				assert.ok(!r.text.includes(s), 'a response carried a secret')
			}
		}
	} finally {
		process.stdout.write = realOut
		process.stderr.write = realErr
		Object.assign(console, realConsole)
	}

	try {
		const all = seen.join('\n')
		for(const s of [...SECRETS, 'a-brand-new-secret-value', ADMIN_TOKEN]) {
			assert.ok(!all.includes(s), 'a secret reached stdout/stderr/console')
		}

		const disk = await readFile(join(dir, 'installations.json'), 'utf8')
		for(const s of [SHOPIFY_SECRET_A, SHOPIFY_SECRET_B, 'a-brand-new-secret-value']) {
			assert.ok(!disk.includes(s), 'a webhook secret is on disk in plaintext')
		}

		assert.match(JSON.parse(disk)[INST_A].shopifyWebhookSecretSealed, /^v1\./)
	} finally {
		await app.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('uninstall deletes the installation and its sealed webhook secret, on disk too', async() => {
	const dir = await mkdtemp(join(tmpdir(), 'wh-'))
	const file = join(dir, 'installations.json')
	const store = await new InstallationStore(file, { sealKey: SEAL_KEY }).load()
	const { app, hook, uninstall } = await setup({ store })
	try {
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 200)
		assert.equal((await uninstall(INST_A, SIGNING_A)).status, 200)
		assert.equal(store.webhookSecretFor(INST_A), undefined)
		assert.equal(store.get(INST_A), undefined)
		const disk = JSON.parse(await readFile(file, 'utf8'))
		assert.equal(disk[INST_A], undefined)
		assert.ok(disk[INST_B], 'the other installation is untouched')
		// the old secret no longer opens anything, and the other store still works
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 401)
		assert.equal((await hook(INST_B, SHOPIFY_SECRET_B)).status, 200)
		const reloaded = await new InstallationStore(file, { sealKey: SEAL_KEY }).load()
		assert.equal(reloaded.webhookSecretFor(INST_A), undefined)
		assert.equal(reloaded.webhookSecretFor(INST_B), SHOPIFY_SECRET_B)
	} finally {
		await app.close()
		await rm(dir, { recursive: true, force: true })
	}
})

test('uninstall needs the installation\'s own ChatDaddy signature: bad, other-store, stale, unsigned and unknown all -> 401, nothing deleted', async() => {
	const { app, hook, uninstall, notice } = await setup()
	try {
		const body = notice(INST_A)
		const post = headers => app.post('/uninstalled', body, headers)
		assert.equal((await uninstall(INST_A, 'wrong')).status, 401)
		assert.equal((await uninstall(INST_A, SIGNING_B)).status, 401) // B's secret cannot uninstall A
		assert.equal((await post({ 'x-chatdaddy-installation': INST_A })).status, 401)
		assert.equal((await app.post('/uninstalled', body)).status, 401)
		const stale = signUninstalled(SIGNING_A, body, app.clock.t - 3600)
		assert.equal((await post({ 'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': stale })).status, 401)
		const forBody = signUninstalled(SIGNING_A, body, app.clock.t)
		assert.equal((await app.post('/uninstalled', body + ' ', { 'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': forBody })).status, 401)
		assert.equal((await uninstall('55555555-5555-4555-8555-555555555555', SIGNING_A)).status, 401)
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 200, 'A is still installed with its secret')
	} finally {
		await app.close()
	}
})

test('a real signed action call replayed to /uninstalled -> 401, and an uninstall signature on an action route -> 401', async() => {
	const { app, hook, notice } = await setup()
	try {
		// the action body and signature exactly as ChatDaddy would send them for A
		const actionBody = JSON.stringify({ input: { orderId: '1' }, context: { installationId: INST_A }, settings: {} })
		const actionSig = signBotsToApp(SIGNING_A, actionBody, app.clock.t)
		const act = await app.post('/actions/format-order-message', actionBody, { 'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': actionSig })
		assert.equal(act.status, 200, 'the action call is genuine')
		assert.equal((await app.post('/uninstalled', actionBody, { 'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': actionSig })).status, 401)
		// even a notice-shaped body signed under the action label is refused
		const body = notice(INST_A)
		const asAction = signBotsToApp(SIGNING_A, body, app.clock.t)
		assert.equal((await app.post('/uninstalled', body, { 'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': asAction })).status, 401)
		// and the reverse: an uninstall signature does not open an action
		const sig = signUninstalled(SIGNING_A, actionBody, app.clock.t)
		assert.equal((await app.post('/actions/format-order-message', actionBody, { 'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': sig })).status, 401)
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 200, 'nothing was deleted')
	} finally {
		await app.close()
	}
})

test('a correctly signed uninstall body must say event=uninstalled and name the header installation', async() => {
	const { app, hook, uninstall } = await setup()
	try {
		const n = o => JSON.stringify({ event: 'uninstalled', installationId: INST_A, ...o })
		assert.equal((await uninstall(INST_A, SIGNING_A, n({ installationId: INST_B }))).status, 401, 'names another installation')
		assert.equal((await uninstall(INST_A, SIGNING_A, n({ installationId: undefined }))).status, 401, 'names none')
		assert.equal((await uninstall(INST_A, SIGNING_A, n({ event: 'installed' }))).status, 401, 'wrong event')
		assert.equal((await uninstall(INST_A, SIGNING_A, n({ event: undefined }))).status, 401, 'no event')
		assert.equal((await uninstall(INST_A, SIGNING_A, '{}')).status, 401)
		assert.equal((await uninstall(INST_A, SIGNING_A, 'not json')).status, 401)
		assert.equal((await uninstall(INST_A, SIGNING_A, '[]')).status, 401)
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 200, 'nothing was deleted')
		assert.equal((await uninstall(INST_A, SIGNING_A, n({}))).status, 200)
	} finally {
		await app.close()
	}
})

test('createApp refuses a short admin token; the config route checks the token before reading the body', async() => {
	await assert.rejects(startApp({ adminToken: 'short' }), /at least 24/)
	const app = await startApp()
	try {
		const big = 'x'.repeat(70 * 1024) // over the body cap: an unauthenticated caller must get 401, not 413
		const res = await app.post(`/installations/${INST_A}/shopify-webhook-secret`, big)
		assert.equal(res.status, 401)
		const authed = await app.post(`/installations/${INST_A}/shopify-webhook-secret`, big, { authorization: `Bearer ${ADMIN_TOKEN}` })
		assert.equal(authed.status, 413)
	} finally {
		await app.close()
	}
})

test('setting the webhook secret: admin token required, installation must exist, secret validated, replaceable', async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await app.setWebhookSecret(INST_A, 'shpss_new_secret_value', null)).status, 401)
		assert.equal((await app.setWebhookSecret(INST_A, 'shpss_new_secret_value', 'wrong')).status, 401)
		assert.equal((await app.setWebhookSecret(INST_A, 'shpss_new_secret_value', ADMIN_TOKEN.slice(0, -1))).status, 401)
		assert.equal((await app.setWebhookSecret('66666666-6666-4666-8666-666666666666', 'shpss_new_secret_value')).status, 404)
		for(const bad of ['', 'short', 'has space in it', 'x'.repeat(257), 42, null]) {
			assert.equal((await app.setWebhookSecret(INST_A, bad)).status, 400)
		}

		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 200, 'rejected writes changed nothing')
		const ok = await app.setWebhookSecret(INST_A, 'shpss_new_secret_value')
		assert.deepEqual(ok.json, { ok: true })
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 401)
		assert.equal((await hook(INST_A, 'shpss_new_secret_value')).status, 200)
	} finally {
		await app.close()
	}
})

test('without an admin token configured the config route is closed', async() => {
	const app = await startApp({ adminToken: undefined })
	try {
		await app.handshake(SIGNING_A, { installationId: INST_A })
		assert.equal((await app.setWebhookSecret(INST_A, 'shpss_new_secret_value')).status, 401)
		assert.equal((await app.setWebhookSecret(INST_A, 'shpss_new_secret_value', '')).status, 401)
		assert.equal((await app.setWebhookSecret(INST_A, 'shpss_new_secret_value', 'undefined')).status, 401)
	} finally {
		await app.close()
	}
})

test('a ChatDaddy secret rotation (re-handshake) keeps the sealed webhook secret', async() => {
	const { app, hook } = await setup()
	try {
		await app.handshake('whsec_rotated_A', { installationId: INST_A, nonce: 'n-9' })
		assert.equal((await hook(INST_A, SHOPIFY_SECRET_A)).status, 200)
	} finally {
		await app.close()
	}
})

test('seal: round-trips, is bound to key and installation id, and rejects tampering', () => {
	const sealed = seal(SEAL_KEY, 'shpss_abc', INST_A)
	assert.notEqual(sealed, seal(SEAL_KEY, 'shpss_abc', INST_A), 'fresh IV each time')
	assert.ok(!sealed.includes('shpss_abc'))
	assert.equal(unseal(SEAL_KEY, sealed, INST_A), 'shpss_abc')
	assert.equal(unseal(SEAL_KEY, sealed, INST_B), undefined, 'moved to another installation')
	assert.equal(unseal(Buffer.alloc(32, 8), sealed, INST_A), undefined, 'wrong key')
	const parts = sealed.split('.')
	for(const i of [1, 2, 3]) {
		const flipped = [...parts]
		flipped[i] = Buffer.from(Buffer.from(parts[i], 'base64url').map((b, j) => (j === 0 ? b ^ 1 : b))).toString('base64url')
		assert.equal(unseal(SEAL_KEY, flipped.join('.'), INST_A), undefined, `part ${i} tampered`)
	}

	for(const junk of [undefined, '', 'v1.a.b', 'v2.a.b.c', 'v1...']) {
		assert.equal(unseal(SEAL_KEY, junk, INST_A), undefined)
	}
})

test('a sealed value copied onto another installation record does not open', async() => {
	const { app } = await setup()
	try {
		app.store.records[INST_B].shopifyWebhookSecretSealed = app.store.records[INST_A].shopifyWebhookSecretSealed
		assert.equal(app.store.webhookSecretFor(INST_B), undefined)
		assert.equal(app.store.webhookSecretFor(INST_A), SHOPIFY_SECRET_A)
	} finally {
		await app.close()
	}
})

test('parseSealKey: 64 hex or 32-byte base64 only', () => {
	assert.equal(parseSealKey('ab'.repeat(32))?.length, 32)
	assert.equal(parseSealKey(Buffer.alloc(32, 1).toString('base64'))?.length, 32)
	for(const bad of [undefined, '', 'ab'.repeat(31), 'zz'.repeat(32), Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64')]) {
		assert.equal(parseSealKey(bad), undefined)
	}
})

test('main refuses to start with a missing or malformed key/token, and never prints them', () => {
	const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url))
	const run = env => spawnSync(process.execPath, [main], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 5000 })
	const base = { CHATDADDY_BOTS_URL: 'https://bots.test.invalid', DATA_FILE: join(tmpdir(), 'never-written.json') }
	for(const env of [
		{ ...base, ADMIN_TOKEN: ADMIN_TOKEN },
		{ ...base, WEBHOOK_SECRET_KEY: 'too-short-key-value-123', ADMIN_TOKEN },
		{ ...base, WEBHOOK_SECRET_KEY: 'ab'.repeat(32) },
		{ ...base, WEBHOOK_SECRET_KEY: 'ab'.repeat(32), ADMIN_TOKEN: 'short-token-value' },
	]) {
		const r = run(env)
		assert.equal(r.status, 1)
		const out = r.stdout + r.stderr
		for(const v of ['too-short-key-value-123', 'short-token-value', ADMIN_TOKEN, 'ab'.repeat(32)]) {
			assert.ok(!out.includes(v), 'startup output carried a secret')
		}
	}
})
