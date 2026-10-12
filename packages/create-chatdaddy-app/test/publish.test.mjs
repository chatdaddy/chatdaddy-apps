import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { publish } from '../src/publish.mjs'
import { validFullManifest } from './fixtures.mjs'
import { close, listen, rmrf, tmp } from './helpers.mjs'

const TOKEN = 'tok-secret-123456'
const urlManifest = { ...validFullManifest, id: 'my-app', handler: { type: 'url', baseUrl: 'https://placeholder.example.com' } }

/** fake appstore: `apps` is the registered set; `failVersion` forces a status on appVersionCreate */
async function fake({ apps = [], failVersion } = {}) {
	const calls = []
	const server = createServer((req, res) => {
		let body = ''
		req.on('data', c => { body += c })
		req.on('end', () => {
			calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined })
			const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)) }
			const m = req.url.match(/^\/apps(?:\/([^/]+)(\/versions)?)?$/)
			if(req.method === 'GET' && m?.[1] && !m[2]) {
				return apps.includes(m[1]) ? send(200, { id: m[1] }) : send(404, { message: 'not found' })
			}

			if(req.method === 'POST' && !m?.[1]) {
				apps.push(JSON.parse(body).id)
				return send(200, {})
			}

			if(req.method === 'POST' && m?.[2]) {
				return failVersion ? send(failVersion, { message: 'version exists' }) : send(200, { id: 1 })
			}

			send(500, {})
		})
	})
	const url = await listen(server)
	return { calls, url, stop: () => close(server) }
}

async function run(manifest, { version = '1.0.0', baseUrl, env = {}, srv } = {}) {
	const dir = tmp()
	try {
		const file = join(dir, 'm.json')
		writeFileSync(file, JSON.stringify(manifest))
		const out = []
		const err = []
		const code = await publish({
			file, baseUrl, version, out: s => out.push(s), err: s => err.push(s),
			env: { CHATDADDY_TOKEN: TOKEN, CHATDADDY_APPSTORE_URL: srv?.url, ...env },
		})
		return { code, out: out.join('\n'), err: err.join('\n') }
	} finally {
		rmrf(dir)
	}
}

test('publish: new app is registered, then the version is created with the --base-url override', async() => {
	const srv = await fake()
	try {
		const r = await run(urlManifest, { baseUrl: 'https://app.mycorp.com', srv })
		assert.equal(r.code, 0, r.err)
		assert.deepEqual(srv.calls.map(c => `${c.method} ${c.url}`), ['GET /apps/my-app', 'POST /apps', 'POST /apps/my-app/versions'])
		assert.ok(srv.calls.every(c => c.auth === `Bearer ${TOKEN}`))
		assert.equal(srv.calls[1].body.id, 'my-app')
		assert.equal(srv.calls[2].body.version, '1.0.0')
		assert.equal(srv.calls[2].body.manifest.handler.baseUrl, 'https://app.mycorp.com')
		assert.match(r.out, /my-app/)
		assert.match(r.out, /version 1\.0\.0/)
		assert.match(r.out, /install/)
		assert.ok(!r.out.includes(TOKEN) && !r.err.includes(TOKEN))
	} finally {
		await srv.stop()
	}
})

test('publish: existing app only gets a new version', async() => {
	const srv = await fake({ apps: ['my-app'] })
	try {
		const r = await run(urlManifest, { version: '1.1.0', srv })
		assert.equal(r.code, 0, r.err)
		assert.deepEqual(srv.calls.map(c => `${c.method} ${c.url}`), ['GET /apps/my-app', 'POST /apps/my-app/versions'])
		assert.equal(srv.calls[1].body.manifest.handler.baseUrl, 'https://placeholder.example.com')
	} finally {
		await srv.stop()
	}
})

test('publish: an invalid manifest never reaches appstore', async() => {
	const srv = await fake()
	try {
		const r = await run({ ...urlManifest, scopes: ['NOT_A_REAL_SCOPE'] }, { srv })
		assert.equal(r.code, 1)
		assert.match(r.err, /INVALID, not publishing/)
		assert.equal(srv.calls.length, 0)
	} finally {
		await srv.stop()
	}
})

test('publish: a 4xx from appstore is reported and exits 1, token never printed', async() => {
	const srv = await fake({ apps: ['my-app'], failVersion: 409 })
	try {
		const r = await run(urlManifest, { srv })
		assert.equal(r.code, 1)
		assert.match(r.err, /appVersionCreate failed: HTTP 409 version exists/)
		assert.ok(!r.err.includes(TOKEN))
	} finally {
		await srv.stop()
	}
})

test('publish: needs a token and a version; refuses a non-https appstore URL', async() => {
	assert.equal((await run(urlManifest, { env: { CHATDADDY_TOKEN: '' } })).code, 2)
	assert.equal((await run(urlManifest, { version: '' })).code, 2)
	const r = await run(urlManifest, { env: { CHATDADDY_APPSTORE_URL: 'http://api.example.com' } })
	assert.equal(r.code, 2)
	assert.match(r.err, /must be https/)
})

test('publish: malformed CHATDADDY_APPSTORE_URL exits 2 with a clear message, no stack', async() => {
	const r = await run(urlManifest, { env: { CHATDADDY_APPSTORE_URL: 'not a url' } })
	assert.equal(r.code, 2)
	assert.match(r.err, /not a valid URL/)
	assert.ok(!r.err.includes(' at '))
})

test('publish: an invalid app id is refused locally, before any request', async() => {
	const srv = await fake()
	try {
		const r = await run({ ...urlManifest, id: 'Bad Id/../x' }, { srv })
		assert.equal(r.code, 1)
		assert.equal(srv.calls.length, 0)
	} finally {
		await srv.stop()
	}
})

test('publish: a redirect is not followed, so the token never reaches the target', async() => {
	const hits = []
	const target = createServer((req, res) => { hits.push(req.headers.authorization); res.end('{}') })
	const targetUrl = await listen(target)
	const redirector = createServer((req, res) => { res.writeHead(302, { location: `${targetUrl}/apps/my-app` }); res.end() })
	const url = await listen(redirector)
	try {
		const r = await run(urlManifest, { srv: { url } })
		assert.equal(r.code, 1)
		assert.deepEqual(hits, [])
		assert.ok(!r.err.includes(TOKEN))
	} finally {
		await close(redirector)
		await close(target)
	}
})
