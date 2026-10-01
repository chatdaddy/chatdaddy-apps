import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { INST_A, INST_B, startApp } from './helpers.mjs'
import { signAppToBots, signBotsToApp } from '../src/signing.mjs'

const manifest = JSON.parse(readFileSync(new URL('../chatdaddy-app.json', import.meta.url), 'utf8'))
const SA = 'whsec_secret_for_A'
const SB = 'whsec_secret_for_B'
const BODY = JSON.stringify({
	input: { orderId: '1001', customerName: 'Ada', total: '41.90', currency: 'USD', itemsSummary: '2 x Shirt' },
	context: { teamId: 'team-1', installationId: INST_A },
	settings: { storeName: 'Acme' },
})

async function setup() {
	const app = await startApp()
	await app.handshake(SA)
	await app.handshake(SB, { installationId: INST_B, nonce: 'n-b' })
	const call = (body, headers) => app.post('/actions/format-order-message', body, headers)
	const signed = (secret, body = BODY, t = app.clock.t) => ({
		'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': signBotsToApp(secret, body, t),
	})
	return { app, call, signed }
}

test('valid signature -> output matching the declared outputProperties', async() => {
	const { app, call, signed } = await setup()
	try {
		const res = await call(BODY, signed(SA))
		assert.equal(res.status, 200)
		const declared = manifest.flowActions.find(a => a.id === 'format-order-message').outputProperties
		assert.deepEqual(Object.keys(res.json).sort(), declared.map(p => p.propertyPath).sort())
		for(const p of declared) {
			assert.equal(typeof res.json[p.propertyPath], p.type)
		}

		assert.match(res.json.message, /Hi Ada, thanks for your order at Acme!/)
		assert.match(res.json.message, /Order #1001 - total 41.90 USD/)
	} finally {
		await app.close()
	}
})

test('wrong secret -> 401', async() => {
	const { app, call, signed } = await setup()
	try {
		assert.equal((await call(BODY, signed('whsec_wrong'))).status, 401)
	} finally {
		await app.close()
	}
})

test("another installation's secret -> 401", async() => {
	const { app, call, signed } = await setup()
	try {
		assert.equal((await call(BODY, signed(SB))).status, 401) // header says A, signed with B's secret
	} finally {
		await app.close()
	}
})

test('unknown installation -> 401 (same answer as a bad signature)', async() => {
	const { app, call } = await setup()
	try {
		const res = await call(BODY, {
			'x-chatdaddy-installation': '33333333-3333-4333-8333-333333333333',
			'x-chatdaddy-signature': signBotsToApp(SA, BODY, app.clock.t),
		})
		assert.equal(res.status, 401)
		assert.deepEqual(res.json, (await call(BODY, { 'x-chatdaddy-installation': INST_A })).json)
	} finally {
		await app.close()
	}
})

test('stale timestamp -> 401', async() => {
	const { app, call, signed } = await setup()
	try {
		assert.equal((await call(BODY, signed(SA, BODY, app.clock.t - 301))).status, 401)
		assert.equal((await call(BODY, signed(SA, BODY, app.clock.t - 299))).status, 200)
	} finally {
		await app.close()
	}
})

test('tampered body -> 401', async() => {
	const { app, call, signed } = await setup()
	try {
		const tampered = BODY.replace('1001', '1002')
		assert.equal((await call(tampered, signed(SA, BODY))).status, 401)
	} finally {
		await app.close()
	}
})

test('app-to-bots signature used as bots-to-app -> 401', async() => {
	const { app, call } = await setup()
	try {
		const res = await call(BODY, {
			'x-chatdaddy-installation': INST_A,
			'x-chatdaddy-signature': signAppToBots(SA, 'evt-1', BODY, app.clock.t),
		})
		assert.equal(res.status, 401)
	} finally {
		await app.close()
	}
})

test('missing signature header -> 401', async() => {
	const { app, call } = await setup()
	try {
		assert.equal((await call(BODY, { 'x-chatdaddy-installation': INST_A })).status, 401)
	} finally {
		await app.close()
	}
})

test('previous secret is accepted inside the rotation window only', async() => {
	const { app, call, signed } = await setup()
	try {
		await app.handshake('whsec_rotated', { nonce: 'n-r' })
		assert.equal((await call(BODY, signed('whsec_rotated'))).status, 200)
		assert.equal((await call(BODY, signed(SA))).status, 200)
		app.clock.t += 15 * 60 + 1
		assert.equal((await call(BODY, signed(SA, BODY, app.clock.t))).status, 401)
		assert.equal((await call(BODY, signed('whsec_rotated', BODY, app.clock.t))).status, 200)
	} finally {
		await app.close()
	}
})

test('authenticated: unknown action 404, context for another installation 400, missing orderId 400', async() => {
	const { app, signed } = await setup()
	try {
		assert.equal((await app.post('/actions/nope', BODY, signed(SA))).status, 404)
		const other = BODY.replace(INST_A, INST_B)
		assert.equal((await app.post('/actions/format-order-message', other, signed(SA, other))).status, 400)
		const noId = JSON.stringify({ input: {} })
		assert.equal((await app.post('/actions/format-order-message', noId, signed(SA, noId))).status, 400)
		// __proto__-style names never reach Object.prototype
		assert.equal((await app.post('/actions/constructor', BODY, signed(SA))).status, 404)
	} finally {
		await app.close()
	}
})
