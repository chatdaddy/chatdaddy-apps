import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { INST_A, startApp } from './helpers.mjs'
import { InstallationStore } from '../src/store.mjs'

const port = app => new URL(app.base).port

test('a slow-drip body is cut off at the body timeout (no socket held open)', { timeout: 5000 }, async() => {
	const app = await startApp({ bodyTimeoutMs: 100 })
	try {
		await new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port: port(app), method: 'POST', path: '/actions/shout', headers: { 'content-type': 'application/json', 'content-length': '1000' } })
			req.on('error', resolve)
			req.on('close', resolve)
			req.on('response', res => reject(new Error(`unexpected response ${res.statusCode}`)))
			// if the server never cuts us off, fail instead of hanging
			req.setTimeout(2000, () => {
				req.destroy()
				reject(new Error('the server held the socket open past its body timeout'))
			})
			req.write('{"in')
		})
	} finally {
		await app.close()
	}
})

test('a declared content-length over the cap is refused with 413 and Connection: close', { timeout: 5000 }, async() => {
	const app = await startApp()
	try {
		const res = await new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port: port(app), method: 'POST', path: '/installed', headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } })
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

test('a chunked body (no content-length) over the cap is cut off with 413', { timeout: 5000 }, async() => {
	const app = await startApp()
	try {
		const res = await new Promise((resolve, reject) => {
			const req = request({ host: '127.0.0.1', port: port(app), method: 'POST', path: '/installed', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } })
			req.on('response', resolve)
			req.on('error', reject)
			req.write('x'.repeat(40 * 1024))
			req.write('x'.repeat(40 * 1024))
			req.end()
		})
		assert.equal(res.statusCode, 413)
		res.resume()
	} finally {
		await app.close()
	}
})

test('an action id that decodes to a path separator, or is not a slug, is refused before anything else', async() => {
	const app = await startApp()
	try {
		for(const id of ['a%2Fb', 'Shout', 'a_b', '..%2F..%2Fetc']) {
			const res = await fetch(`${app.base}/actions/${id}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
			assert.equal(res.status, 404, id)
		}
	} finally {
		await app.close()
	}
})

// a read-only directory does not stop root, so these two cannot prove anything as root
const notRoot = { skip: process.getuid?.() === 0 && 'running as root' }

test('a failed persist rolls the record back, surfaces the error, and does not block later writes', notRoot, async() => {
	const dir = await mkdtemp(join(tmpdir(), 'store-'))
	try {
		const file = join(dir, 'data', 'installations.json')
		const store = await new InstallationStore(file).load()
		await store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 'whsec_one' }, 1000)
		await chmod(join(dir, 'data'), 0o500) // read-only: the next write fails
		await assert.rejects(store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 'whsec_two' }, 1001))
		assert.equal(store.currentSecret(INST_A), 'whsec_one', 'memory rolled back to what is on disk')
		await chmod(join(dir, 'data'), 0o700)
		await store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 'whsec_three' }, 1002)
		assert.equal(store.currentSecret(INST_A), 'whsec_three', 'a later write succeeds')
		assert.equal((await new InstallationStore(file).load()).currentSecret(INST_A), 'whsec_three')
	} finally {
		await chmod(join(dir, 'data'), 0o700).catch(() => undefined)
		await rm(dir, { recursive: true, force: true })
	}
})

test('a failed first persist leaves no record behind', notRoot, async() => {
	const dir = await mkdtemp(join(tmpdir(), 'store-'))
	try {
		const store = await new InstallationStore(join(dir, 'data', 'installations.json')).load()
		await store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 's' }, 1000)
		await chmod(join(dir, 'data'), 0o500)
		await assert.rejects(store.saveHandshake({ installationId: 'another', teamId: 't', appId: 'a', signingSecret: 's2' }, 1001))
		assert.equal(store.get('another'), undefined)
	} finally {
		await chmod(join(dir, 'data'), 0o700).catch(() => undefined)
		await rm(dir, { recursive: true, force: true })
	}
})

test('the app source never calls console.*', async() => {
	const { readdirSync, readFileSync } = await import('node:fs')
	const dir = new URL('../src/', import.meta.url)
	for(const f of readdirSync(dir)) {
		assert.ok(!/console\./.test(readFileSync(new URL(f, dir), 'utf8')), `${f} uses console`)
	}
})

test('an unexpected error is logged, and its message is never sent to the client', async() => {
	const entries = []
	const app = await startApp({
		log: (level, msg, extra) => entries.push({ level, msg, extra }),
		getPublicKey: () => {
			throw new Error('secret-detail-whsec_123')
		},
	})
	try {
		const res = await app.handshake('whsec_x')
		assert.equal(res.status, 500)
		assert.deepEqual(res.json, { error: 'internal error' })
		assert.ok(!res.text.includes('whsec_123'))
		assert.deepEqual(entries.map(e => [e.level, e.msg]), [['error', 'unexpected error']])
		assert.equal(entries[0].extra.error, 'secret-detail-whsec_123')
	} finally {
		await app.close()
	}
})
