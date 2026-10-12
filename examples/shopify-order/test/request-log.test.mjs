import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ADMIN_TOKEN, INST_A, SHOPIFY_SECRET_A, mintToken } from './helpers.mjs'
import { startApp } from './helpers.mjs'

test('one log line per handled request: route, installation id, status, and nothing secret', async() => {
	const lines = []
	const app = await startApp({ log: l => lines.push(l) })
	try {
		await app.handshake('whsec_log_signing', { installationId: INST_A })
		await app.setWebhookSecret(INST_A, SHOPIFY_SECRET_A)
		await app.handshake('whsec_log_signing', { token: 'garbage' })
		await app.post(`/shopify/webhook/${INST_A}`, '{}', { 'x-shopify-hmac-sha256': 'bad' })
		assert.deepEqual(lines.map(l => [l.route, l.installationId, l.status]), [
			['/installed', INST_A, 200],
			['/installations/:id/shopify-webhook-secret', INST_A, 200],
			['/installed', undefined, 401],
			['/shopify/webhook/:id', INST_A, 401],
		])
		const text = JSON.stringify(lines)
		for(const s of ['whsec_log_signing', SHOPIFY_SECRET_A, ADMIN_TOKEN, mintToken({ installationId: INST_A }).slice(0, 20), 'Bearer']) {
			assert.ok(!text.includes(s), 'no secret in the log')
		}
	} finally {
		await app.close()
	}
})

test('a log function that throws cannot break a response', async() => {
	const app = await startApp({ log: () => { throw new Error('transport down') } })
	try {
		const res = await app.post('/installed', {}, { authorization: 'Bearer garbage' })
		assert.equal(res.status, 401)
		const ok = await app.handshake('whsec_x', { installationId: INST_A })
		assert.equal(ok.status, 200)
	} finally {
		await app.close()
	}
})
