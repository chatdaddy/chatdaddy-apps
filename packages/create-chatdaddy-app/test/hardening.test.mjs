import assert from 'node:assert/strict'
import { request } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { MAX_MANIFEST_BYTES, main } from '../src/cli.mjs'
import { createTriggerServer } from '../src/dev/trigger-server.mjs'
import { validate } from '../src/validate/index.mjs'
import { rmrf, tmp } from './helpers.mjs'

const session = { installationId: 'inst-1', manifest: { flowTriggers: [] }, fired: [] }

async function withServer(opts, fn) {
	const t = createTriggerServer({ session, ...opts })
	const port = await t.listen()
	try {
		return await fn(port)
	} finally {
		t.server.closeAllConnections()
		await t.close()
	}
}

const raw = (port, { path = '/apps/triggers/inst-1/t', headers = {}, body } = {}) => new Promise((resolve, reject) => {
	const req = request({ host: '127.0.0.1', port, method: 'POST', path, headers })
	req.on('response', res => {
		let text = ''
		res.on('data', c => { text += c })
		res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
	})
	req.on('error', () => resolve({ status: 'closed' }))
	req.setTimeout(3000, () => {
		req.destroy()
		reject(new Error('the dev server held the socket open'))
	})
	if(body !== undefined) {
		req.end(body)
	} else {
		req.write('{"in')
	}
})

test('dev trigger server: a slow-drip body is cut off at the body timeout', { timeout: 5000 }, async() => {
	await withServer({ bodyTimeoutMs: 100 }, async port => {
		const r = await raw(port, { headers: { 'content-type': 'application/json', 'content-length': '1000' } })
		assert.equal(r.status, 'closed')
	})
})

test('dev trigger server: a declared body over 64 KB is a 413 with connection: close, before reading', { timeout: 5000 }, async() => {
	await withServer({}, async port => {
		const r = await raw(port, { headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } })
		assert.equal(r.status, 413)
		assert.equal(r.headers.connection, 'close')
	})
})

test('dev trigger server: an unexpected error is a 500, and the server keeps serving', { timeout: 5000 }, async() => {
	await withServer({}, async port => {
		// a malformed percent-escape makes decodeURIComponent throw inside the handler
		const bad = await raw(port, { path: '/apps/triggers/%E0%A4%A/t', body: '{}' })
		assert.equal(bad.status, 500)
		const next = await raw(port, { path: '/apps/triggers/other/t', body: '{}' })
		assert.equal(next.status, 404)
	})
})

test('validate: a pattern that does not compile, or is implausibly long, never matches and never throws', () => {
	assert.doesNotThrow(() => validate({ type: 'string', pattern: '(' }, 'x'))
	assert.ok(validate({ type: 'string', pattern: '(' }, 'x').length > 0)
	assert.ok(validate({ type: 'string', pattern: 'a'.repeat(2000) }, 'a'.repeat(2000)).length > 0)
	assert.equal(validate({ type: 'string', pattern: '^a+$' }, 'aaa').length, 0)
})

test('validate: a manifest file over the size cap is refused before it is read', () => {
	const dir = tmp()
	try {
		const file = join(dir, 'big.json')
		writeFileSync(file, ' '.repeat(MAX_MANIFEST_BYTES + 1))
		const errors = []
		const code = main(['validate', file], { stderr: s => errors.push(s), stdout: () => {} })
		return Promise.resolve(code).then(c => {
			assert.equal(c, 2)
			assert.match(errors.join('\n'), /larger than/)
		})
	} finally {
		rmrf(dir)
	}
})
