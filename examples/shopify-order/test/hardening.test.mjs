import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { InstallationStore } from '../src/store.mjs'
import { INST_A, startApp } from './helpers.mjs'

test('a slow-drip body is cut off at the body timeout (no socket held open)', { timeout: 5000 }, async() => {
	const app = await startApp({ bodyTimeoutMs: 100 })
	try {
		const port = new URL(app.base).port
		const closedAt = await new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/actions/format-order-message', headers: { 'content-type': 'application/json', 'content-length': '1000' } })
			req.on('error', () => resolve(Date.now()))
			req.on('close', () => resolve(Date.now()))
			req.on('response', res => reject(new Error(`unexpected response ${res.statusCode}`)))
			// if the server never cuts us off, fail instead of hanging
			req.setTimeout(2000, () => {
				req.destroy()
				reject(new Error('the server held the socket open past its body timeout'))
			})
			req.write('{"in')
		})
		assert.ok(closedAt, 'the server closed the connection')
	} finally {
		await app.close()
	}
})

test('an action id that decodes to a path separator is refused before anything else', async() => {
	const app = await startApp()
	try {
		const res = await fetch(`${app.base}/actions/a%2Fb`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
		assert.equal(res.status, 404)
	} finally {
		await app.close()
	}
})

test('a failed persist rolls the record back, surfaces the error, and does not block later writes', async() => {
	const dir = await mkdtemp(join(tmpdir(), 'store-'))
	try {
		const store = await new InstallationStore(join(dir, 'data', 'installations.json')).load()
		await store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 'whsec_one' }, 1000)
		await chmod(join(dir, 'data'), 0o500) // read-only: the next write fails
		await assert.rejects(store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 'whsec_two' }, 1001))
		assert.equal(store.currentSecret(INST_A), 'whsec_one', 'memory rolled back to what is on disk')
		await chmod(join(dir, 'data'), 0o700)
		await store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 'whsec_three' }, 1002)
		assert.equal(store.currentSecret(INST_A), 'whsec_three', 'a later write succeeds')
		const reloaded = await new InstallationStore(join(dir, 'data', 'installations.json')).load()
		assert.equal(reloaded.currentSecret(INST_A), 'whsec_three')
	} finally {
		await chmod(join(dir, 'data'), 0o700).catch(() => undefined)
		await rm(dir, { recursive: true, force: true })
	}
})

test('an over-cap body gets 413 with Connection: close, so the rest of the upload is dropped', { timeout: 5000 }, async() => {
	const app = await startApp()
	try {
		const port = new URL(app.base).port
		const res = await new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port, method: 'POST', path: `/shopify/webhook/${INST_A}`, headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } })
			req.on('response', resolve)
			req.on('error', reject)
			req.write('{"x":"')
		})
		assert.equal(res.statusCode, 413)
		assert.equal(res.headers.connection, 'close')
		res.resume()
	} finally {
		await app.close()
	}
})
