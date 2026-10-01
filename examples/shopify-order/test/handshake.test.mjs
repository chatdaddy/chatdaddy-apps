import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_ID, INST_A, INST_B, TEAM, mintToken, otherKeys, startApp } from './helpers.mjs'
import { PREVIOUS_SECRET_WINDOW_S } from '../src/store.mjs'
import { computeHandshakeAck } from '../src/signing.mjs'

const SECRET = 'whsec_installsecret'

async function rejected(name, tokenOpts) {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, { token: typeof tokenOpts === 'string' ? tokenOpts : mintToken(tokenOpts) })
		assert.equal(res.status, 401, name)
		assert.equal(app.store.get(INST_A), undefined, `${name}: nothing stored`)
		assert.ok(!res.text.includes(SECRET), 'secret not echoed')
	} finally {
		await app.close()
	}
}

test('valid handshake: 200, ack per the bots formula, secret stored', async() => {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, { nonce: 'nonce123' })
		assert.equal(res.status, 200)
		assert.deepEqual(Object.keys(res.json), ['ack'])
		assert.equal(res.json.ack, computeHandshakeAck(SECRET, 'nonce123'))
		// independent of our own function: HMAC(secret, "chatdaddy/v1/handshake-ack:nonce123")
		const { createHmac } = await import('node:crypto')
		assert.equal(res.json.ack, createHmac('sha256', SECRET).update('chatdaddy/v1/handshake-ack:nonce123').digest('hex'))
		assert.deepEqual(app.store.get(INST_A), { installationId: INST_A, teamId: TEAM, appId: APP_ID, signingSecret: SECRET })
	} finally {
		await app.close()
	}
})

test('JWT signed by another key -> 401, nothing stored', () => rejected('bad signature', { keys: otherKeys }))
test('expired JWT -> 401', () => rejected('expired', { exp: Math.floor(Date.now() / 1000) - 10 }))
test('non-ES256 header (valid ES256 signature) -> 401', () => rejected('HS256 header', { headerAlg: 'HS256' }))
test('alg none -> 401', () => rejected('none', { headerAlg: 'none' }))
test('objectId for another installation -> 401', () => rejected('objectId inst', { installationId: INST_B }))
test('objectId for another app -> 401', () => rejected('objectId app', { appId: 'someone-elses-app' }))
test('metadata type not app -> 401', () => rejected('type', { metadata: { type: 'user', objectId: `app_${APP_ID}/inst_${INST_A}` } }))
test('token for another team -> 401', () => rejected('team', { userTeamId: 'team-2' }))
test('missing / garbage token -> 401', async() => {
	await rejected('empty', '')
	await rejected('garbage', 'a.b.c')
	await rejected('two parts', 'a.b')
})

test('token valid but body names a different app -> 401', async() => {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, {
			body: { installationId: INST_A, teamId: TEAM, appId: 'other-app', signingSecret: SECRET, nonce: 'n' },
		})
		assert.equal(res.status, 401)
		assert.equal(app.store.get(INST_A), undefined)
	} finally {
		await app.close()
	}
})

test('token and body agree, but on an app that is not this one -> 401', async() => {
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

test('authenticated but malformed body -> 400, nothing stored', async() => {
	const app = await startApp()
	try {
		const res = await app.handshake(SECRET, {
			body: { installationId: INST_A, teamId: TEAM, appId: APP_ID, nonce: 'n' },
		})
		assert.equal(res.status, 400)
		assert.equal(app.store.get(INST_A), undefined)
	} finally {
		await app.close()
	}
})

test('oversized body -> 413', async() => {
	const app = await startApp()
	try {
		const res = await app.post('/installed', 'x'.repeat(70 * 1024), { authorization: `Bearer ${mintToken()}` })
		assert.equal(res.status, 413)
	} finally {
		await app.close()
	}
})

test('re-handshake with a new secret keeps the old one for the window only', async() => {
	const app = await startApp()
	try {
		await app.handshake('whsec_old')
		await app.handshake('whsec_new', { nonce: 'n-2' })
		assert.deepEqual(app.store.secretsFor(INST_A, app.clock.t), ['whsec_new', 'whsec_old'])
		assert.deepEqual(app.store.secretsFor(INST_A, app.clock.t + PREVIOUS_SECRET_WINDOW_S + 1), ['whsec_new'])
		// the same secret delivered again leaves the open window untouched
		await app.handshake('whsec_new', { nonce: 'n-3' })
		assert.deepEqual(app.store.secretsFor(INST_A, app.clock.t), ['whsec_new', 'whsec_old'])
	} finally {
		await app.close()
	}
})
