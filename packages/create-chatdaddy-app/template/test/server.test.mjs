import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { APP_ID, INST_A, INST_B, TEAM, manifest, mintToken, otherKeys, startApp } from './helpers.mjs'
import { computeHandshakeAck, signBotsToApp } from '../src/signing.mjs'

const SECRET = 'whsec_installsecret'

test('handshake: 200, ack per the ChatDaddy formula, secret stored', async() => {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, { nonce: 'nonce123' })
		assert.equal(res.status, 200)
		assert.deepEqual(Object.keys(res.json), ['ack'])
		assert.equal(res.json.ack, computeHandshakeAck(SECRET, 'nonce123'))
		// independent of our own function: HMAC(secret, "chatdaddy/v1/handshake-ack:nonce123")
		assert.equal(res.json.ack, createHmac('sha256', SECRET).update('chatdaddy/v1/handshake-ack:nonce123').digest('hex'))
		assert.deepEqual(app.store.get(INST_A), { installationId: INST_A, teamId: TEAM, appId: APP_ID, signingSecret: SECRET })
	} finally {
		await app.close()
	}
})

for(const [name, opts] of Object.entries({
	'token signed by another key': { keys: otherKeys },
	'expired token': { exp: Math.floor(Date.now() / 1000) - 10 },
	'token for another installation': { installationId: INST_B },
	'token for another app': { appId: 'someone-elses-app' },
	'token for another team': { teamId: 'team-2' },
	'header alg is HS256 (with a valid ES256 signature)': { headerAlg: 'HS256' },
	'header alg is none': { headerAlg: 'none' },
	'metadata type is not app': { metadata: { type: 'user', objectId: `app_${APP_ID}/inst_${INST_A}` } },
})) {
	test(`handshake refused (401, nothing stored): ${name}`, async() => {
		const app = await startApp()
		try {
			// body says team-1 / inst A / this app; only the token differs
			const res = await app.handshake(SECRET, { token: mintToken(opts) })
			assert.equal(res.status, 401)
			assert.equal(app.store.get(INST_A), undefined)
		} finally {
			await app.close()
		}
	})
}

test('handshake refused: missing or garbage token', async() => {
	const app = await startApp()
	try {
		for(const token of ['', 'a.b.c', 'a.b']) {
			assert.equal((await app.handshake(SECRET, { token })).status, 401, token)
		}
	} finally {
		await app.close()
	}
})

test('handshake refused: body names a different app', async() => {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, {
			body: { installationId: INST_A, teamId: TEAM, appId: 'other-app', signingSecret: SECRET, nonce: 'n' },
		})
		assert.equal(res.status, 401)
	} finally {
		await app.close()
	}
})

test('handshake refused: token and body agree, but on an app that is not this one', async() => {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, {
			token: mintToken({ appId: 'other-app' }),
			body: { installationId: INST_A, teamId: TEAM, appId: 'other-app', signingSecret: SECRET, nonce: 'n' },
		})
		assert.equal(res.status, 401)
		assert.equal(app.store.get(INST_A), undefined)
	} finally {
		await app.close()
	}
})

test('authenticated but malformed body: 400', async() => {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, { body: { installationId: INST_A, teamId: TEAM, appId: APP_ID, nonce: 'n' } })
		assert.equal(res.status, 400)
	} finally {
		await app.close()
	}
})

const BODY = JSON.stringify({ input: { text: ' hello ' }, context: { teamId: TEAM, installationId: INST_A }, settings: {} })

async function installed() {
	const app = await startApp()
	await app.handshake(SECRET)
	await app.handshake('whsec_other_installation', { installationId: INST_B, nonce: 'n-b' })
	const call = (body, headers) => app.post('/actions/shout', body, headers)
	const signed = (secret, body = BODY) => ({
		'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': signBotsToApp(secret, body, app.clock.t),
	})
	return { app, call, signed }
}

test('action: valid signature answers with the declared outputProperties', async() => {
	const { app, call, signed } = await installed()
	try {
		const res = await call(BODY, signed(SECRET))
		assert.equal(res.status, 200)
		const declared = manifest.flowActions.find(a => a.id === 'shout').outputProperties
		assert.deepEqual(Object.keys(res.json).sort(), declared.map(p => p.propertyPath).sort())
		for(const p of declared) {
			assert.equal(typeof res.json[p.propertyPath], p.type)
		}

		assert.equal(res.json.result, 'HELLO')
	} finally {
		await app.close()
	}
})

test('action: wrong secret, another installation\'s secret, stale timestamp, unknown installation: all 401', async() => {
	const { app, call, signed } = await installed()
	try {
		assert.equal((await call(BODY, signed('whsec_wrong'))).status, 401)
		assert.equal((await call(BODY, signed('whsec_other_installation'))).status, 401)
		assert.equal((await call(BODY, {
			'x-chatdaddy-installation': INST_A, 'x-chatdaddy-signature': signBotsToApp(SECRET, BODY, app.clock.t - 400),
		})).status, 401)
		assert.equal((await call(BODY, {
			'x-chatdaddy-installation': '33333333-3333-4333-8333-333333333333', 'x-chatdaddy-signature': signBotsToApp(SECRET, BODY, app.clock.t),
		})).status, 401)
		assert.equal((await call(BODY, {})).status, 401)
	} finally {
		await app.close()
	}
})

test('action: a tampered body no longer matches its signature', async() => {
	const { app, call, signed } = await installed()
	try {
		assert.equal((await call(BODY.replace('hello', 'HELLO'), signed(SECRET))).status, 401)
	} finally {
		await app.close()
	}
})

test('action: unknown action id is 404, including prototype names', async() => {
	const { app, signed } = await installed()
	try {
		assert.equal((await app.post('/actions/nope', BODY, signed(SECRET))).status, 404)
		assert.equal((await app.post('/actions/constructor', BODY, signed(SECRET))).status, 404)
	} finally {
		await app.close()
	}
})

test('action: a handler error is a 400 with the message', async() => {
	const { app, call, signed } = await installed()
	try {
		const body = JSON.stringify({ input: {}, context: { installationId: INST_A } })
		const res = await call(body, signed(SECRET, body))
		assert.equal(res.status, 400)
		assert.equal(res.json.error, 'text is required')
	} finally {
		await app.close()
	}
})

test('action: a body whose context names another installation is refused', async() => {
	const { app, call, signed } = await installed()
	try {
		const body = JSON.stringify({ input: { text: 'x' }, context: { installationId: INST_B } })
		assert.equal((await call(body, signed(SECRET, body))).status, 400)
	} finally {
		await app.close()
	}
})

test('every action in the manifest has a handler, and vice versa', async() => {
	const { ACTIONS } = await import('../src/actions.mjs')
	assert.deepEqual(Object.keys(ACTIONS).sort(), manifest.flowActions.map(a => a.id).sort())
})
