import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { main } from '../src/cli.mjs'
import { close, listen, rmrf, tmp } from './helpers.mjs'

const TOKEN = 'tok-abc-123456'
const SECRET = 'sup3r-s3cret-value-XYZ'
const manifest = {
	id: 'my-app',
	connections: [{ id: 'shopify', type: 'oauth2' }, { id: 'key', type: 'apiKey' }],
}

async function fake(status = 200, reply = { clientId: 'cid', secretSet: true }) {
	const calls = []
	const server = createServer((req, res) => {
		let body = ''
		req.on('data', c => { body += c })
		req.on('end', () => {
			calls.push({ method: req.method, url: req.url, h: req.headers, body: JSON.parse(body) })
			res.writeHead(status, { 'content-type': 'application/json' })
			res.end(JSON.stringify(reply))
		})
	})
	return { calls, url: await listen(server), stop: () => close(server) }
}

async function run(args, { env = {}, stdin, srv } = {}) {
	const dir = tmp()
	const saved = { ...process.env }
	try {
		writeFileSync(join(dir, 'chatdaddy-app.json'), JSON.stringify(manifest))
		for(const k of Object.keys(process.env)) {
			if(k.startsWith('CHATDADDY_')) {
				delete process.env[k]
			}
		}

		Object.assign(process.env, { CHATDADDY_TOKEN: TOKEN, CHATDADDY_BOTS_URL: srv?.url, ...env })
		const out = []
		const err = []
		const code = await main(['set-client', dir, ...args], {
			stdout: s => out.push(s), stderr: s => err.push(s), stdin: stdin && Readable.from([stdin]),
		})
		return { code, out: out.join('\n'), err: err.join('\n') }
	} finally {
		for(const k of Object.keys(process.env)) {
			delete process.env[k]
		}

		Object.assign(process.env, saved)
		rmrf(dir)
	}
}

test('set-client: PUT to the right path with bearer, clientId body, secret header (from env)', async() => {
	const srv = await fake()
	try {
		const r = await run(['--connection', 'shopify', '--client-id', 'cid'], { env: { CHATDADDY_OAUTH_CLIENT_SECRET: SECRET }, srv })
		assert.equal(r.code, 0, r.err)
		assert.equal(r.out, 'OAuth client set for my-app / shopify')
		const c = srv.calls[0]
		assert.equal(`${c.method} ${c.url}`, 'PUT /apps/my-app/oauth-clients/shopify')
		assert.equal(c.h.authorization, `Bearer ${TOKEN}`)
		assert.deepEqual(c.body, { clientId: 'cid' })
		assert.equal(c.h['x-oauth-client-secret'], SECRET)
		assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET))
	} finally {
		await srv.stop()
	}
})

test('set-client: secret from stdin, client id from env', async() => {
	const srv = await fake()
	try {
		const r = await run(['--connection', 'shopify', '--secret-stdin'], { env: { CHATDADDY_OAUTH_CLIENT_ID: 'env-cid' }, stdin: `${SECRET}\n`, srv })
		assert.equal(r.code, 0, r.err)
		assert.equal(srv.calls[0].h['x-oauth-client-secret'], SECRET)
		assert.equal(srv.calls[0].body.clientId, 'env-cid')
	} finally {
		await srv.stop()
	}
})

test('set-client: a --client-secret flag is refused and never sent', async() => {
	const srv = await fake()
	try {
		const r = await run(['--connection', 'shopify', '--client-id', 'cid', '--client-secret', SECRET], { srv })
		assert.equal(r.code, 2)
		assert.equal(srv.calls.length, 0)
		assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET))
	} finally {
		await srv.stop()
	}
})

test('set-client: non-oauth2 and unknown connections are refused, no request', async() => {
	const srv = await fake()
	try {
		const env = { CHATDADDY_OAUTH_CLIENT_SECRET: SECRET }
		const a = await run(['--connection', 'key', '--client-id', 'cid'], { env, srv })
		assert.equal(a.code, 2)
		assert.match(a.err, /not oauth2/)
		const b = await run(['--connection', 'nope', '--client-id', 'cid'], { env, srv })
		assert.equal(b.code, 2)
		assert.equal(srv.calls.length, 0)
	} finally {
		await srv.stop()
	}
})

test('set-client: server error prints status and message, never the secret', async() => {
	const srv = await fake(400, { message: `invalid-client-secret ${SECRET}` })
	try {
		const r = await run(['--connection', 'shopify', '--client-id', 'cid'], { env: { CHATDADDY_OAUTH_CLIENT_SECRET: SECRET }, srv })
		assert.equal(r.code, 1)
		assert.match(r.err, /HTTP 400 invalid-client-secret/)
		assert.ok(!r.out.includes(SECRET) && !r.err.includes(SECRET))
	} finally {
		await srv.stop()
	}
})
