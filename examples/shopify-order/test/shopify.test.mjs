import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOTS_URL, INST_A, INST_B, SAMPLE_ORDER, SHOPIFY_SECRET_A, shopifyHmac, startApp } from './helpers.mjs'
import { verifyAppToBots, verifyBotsToApp } from '../src/signing.mjs'
import { MAX_SHOPIFY_BODY_BYTES } from '../src/server.mjs'

const SECRET = 'whsec_secret_for_A'
const RAW = JSON.stringify(SAMPLE_ORDER)

async function setup() {
	const app = await startApp()
	await app.handshake(SECRET)
	await app.setWebhookSecret(INST_A, SHOPIFY_SECRET_A)
	const hook = (raw = RAW, { id = 'wh-0001', secret = SHOPIFY_SECRET_A, topic = 'orders/create', inst = INST_A, hmac } = {}) => app.post(
		`/shopify/webhook/${inst}`, raw,
		{
			'x-shopify-hmac-sha256': hmac ?? shopifyHmac(secret, raw), 'x-shopify-topic': topic,
			...(id === null ? {} : { 'x-shopify-webhook-id': id }),
		}
	)
	return { app, hook }
}

test('bad Shopify HMAC -> 401 and no outbound call', async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await hook(RAW, { secret: 'wrong' })).status, 401)
		assert.equal((await hook(RAW, { hmac: '' })).status, 401)
		assert.equal((await hook(RAW, { hmac: 'AAAA' })).status, 401)
		const raw2 = RAW.replace('1001', '1002') // valid HMAC for the original body
		assert.equal((await hook(raw2, { hmac: shopifyHmac(SHOPIFY_SECRET_A, RAW) })).status, 401)
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})

test('valid webhook -> exactly one outbound call, correct path, event id, mapping and signature', async() => {
	const { app, hook } = await setup()
	try {
		const res = await hook()
		assert.equal(res.status, 200)
		assert.equal(app.calls.length, 1)
		const { url, init } = app.calls[0]
		assert.equal(url, `${BOTS_URL}/apps/triggers/${INST_A}/shopify-order-created`)
		assert.equal(init.method, 'POST')
		assert.equal(init.headers['content-type'], 'application/json')
		assert.equal(init.headers['x-chatdaddy-event-id'], 'wh-0001')
		assert.deepEqual(JSON.parse(init.body), {
			orderId: '1001', customerName: 'Ada Lovelace', phone: '+447700900123',
			total: '41.90', currency: 'USD', itemsSummary: '2 x Shirt, 1 x Hat',
		})
		assert.ok(Buffer.byteLength(init.body) <= 64 * 1024)
		const sig = init.headers['x-chatdaddy-signature']
		assert.equal(verifyAppToBots(SECRET, 'wh-0001', init.body, sig, app.clock.t), true)
		assert.equal(verifyAppToBots(SECRET, 'other-id', init.body, sig, app.clock.t), false)
		assert.equal(verifyAppToBots(SECRET, 'wh-0001', init.body + ' ', sig, app.clock.t), false)
		// a signature is not usable in the other direction
		assert.equal(verifyBotsToApp(SECRET, init.body, sig, app.clock.t), false)
	} finally {
		await app.close()
	}
})

test('re-delivery (same X-Shopify-Webhook-Id) reuses the event id; a new id gets a new one', async() => {
	const { app, hook } = await setup()
	try {
		await hook(RAW, { id: 'wh-same' })
		await hook(RAW, { id: 'wh-same' })
		await hook(RAW, { id: 'wh-other' })
		const ids = app.calls.map(c => c.init.headers['x-chatdaddy-event-id'])
		assert.deepEqual(ids, ['wh-same', 'wh-same', 'wh-other'])
		assert.equal(app.calls[0].init.body, app.calls[1].init.body)
	} finally {
		await app.close()
	}
})

test('HMAC is over the raw bytes, not re-serialised JSON', async() => {
	const { app, hook } = await setup()
	try {
		const spaced = `{ "id": 1,   "order_number": 7,\n "customer": {"phone": "+1555", "first_name": "A"}, "line_items": [] }`
		assert.notEqual(spaced, JSON.stringify(JSON.parse(spaced)))
		assert.equal((await hook(spaced)).status, 200)
		assert.equal(app.calls.length, 1)
		// HMAC of the re-serialised form must NOT validate the spaced bytes
		assert.equal((await hook(spaced, { hmac: shopifyHmac(SHOPIFY_SECRET_A, JSON.stringify(JSON.parse(spaced))) })).status, 401)
		assert.equal(app.calls.length, 1)
	} finally {
		await app.close()
	}
})

test('outbound signature uses the current secret after a rotation handshake', async() => {
	const { app, hook } = await setup()
	try {
		await app.handshake('whsec_rotated', { nonce: 'n-2' })
		await hook()
		const { init } = app.calls[0]
		assert.equal(verifyAppToBots('whsec_rotated', 'wh-0001', init.body, init.headers['x-chatdaddy-signature'], app.clock.t), true)
		assert.equal(verifyAppToBots(SECRET, 'wh-0001', init.body, init.headers['x-chatdaddy-signature'], app.clock.t), false)
	} finally {
		await app.close()
	}
})

test('unknown installation -> 401, no call', async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await hook(RAW, { inst: INST_B })).status, 401)
		assert.equal((await hook(RAW, { inst: 'not-a-uuid' })).status, 401)
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})

test('other topics, orders without a phone: acknowledged, nothing sent', async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await hook(RAW, { topic: 'orders/paid' })).status, 200)
		const noPhone = JSON.stringify({ ...SAMPLE_ORDER, customer: { first_name: 'A' } })
		const res = await hook(noPhone)
		assert.equal(res.status, 200)
		assert.ok(res.json.skipped)
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})

test('missing or invalid webhook id -> 400, no call', async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await hook(RAW, { id: null })).status, 400)
		assert.equal((await hook(RAW, { id: 'a.b' })).status, 400)
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})

test('bots failure or unreachable -> 502 so Shopify retries', async() => {
	const { app, hook } = await setup()
	try {
		app.state.response = () => new Response('{}', { status: 401 })
		assert.equal((await hook()).status, 502)
		app.state.throwError = new Error('ECONNREFUSED')
		assert.equal((await hook()).status, 502)
		app.state.throwError = undefined
		app.state.response = () => new Response('{"duplicate":true}', { status: 200 })
		assert.equal((await hook()).status, 200)
	} finally {
		await app.close()
	}
})

test('outbound payload stays under 64 KB for huge orders', async() => {
	const { app, hook } = await setup()
	try {
		const big = JSON.stringify({ ...SAMPLE_ORDER, line_items: Array.from({ length: 5000 }, (_, i) => ({ title: `Item number ${i}`, quantity: 1 })) })
		assert.equal((await hook(big)).status, 200)
		assert.ok(Buffer.byteLength(app.calls[0].init.body) < 64 * 1024)
		assert.match(JSON.parse(app.calls[0].init.body).itemsSummary, /\.\.\.$/)
	} finally {
		await app.close()
	}
})

test('webhook body over the cap -> 413 before any HMAC work', async() => {
	const { app, hook } = await setup()
	try {
		assert.equal((await hook('x'.repeat(MAX_SHOPIFY_BODY_BYTES + 1))).status, 413)
		assert.equal(app.calls.length, 0)
	} finally {
		await app.close()
	}
})
