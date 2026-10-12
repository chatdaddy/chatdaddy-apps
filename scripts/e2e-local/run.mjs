#!/usr/bin/env node
// Local end-to-end rehearsal of the Shopify order app launch (examples/shopify-order/E2E.md).
// Real bots + real app + localstack KMS + a Postgres database of its own. Stubs only appstore and auth.
// Never sends a WhatsApp message: it stops before any send step. Dummy values only. See README.md.
import { spawn, spawnSync } from 'node:child_process'
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const BOTS_DIR = resolve(process.env.BOTS_DIR || '')
if(!process.env.BOTS_DIR || !existsSync(join(BOTS_DIR, 'node_modules'))) {
	console.error('BOTS_DIR must be a chatdaddy-service-bots checkout with node_modules installed')
	process.exit(2)
}

const bots = createRequire(join(BOTS_DIR, 'package.json'))
const PG_URL = process.env.E2E_PG_URL || 'postgres://postgres@127.0.0.1:5432' // trust auth, local dev container
const BOTS_PORT = 3001 // rest-api-builder's makeServer default; bots has no PORT env
const APP_HOST = 'shopify-app.e2e.test'
const APP_ID = 'shopify-order-whatsapp'
const VERSION = '0.1.0'
const RUN = randomBytes(4).toString('hex')
const DB = `e2e_local_${RUN}`
const LS_NAME = `e2e-local-ls-${RUN}`
const tmp = mkdtempSync(join(tmpdir(), 'e2e-local-'))
const children = []
const results = []
let cleanups = []

const dummy = () => randomBytes(24).toString('hex')
const ADMIN_TOKEN = dummy()
const SHOP_SECRET = `shpss_${randomBytes(16).toString('hex')}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const freePort = () => new Promise(res => {
	const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})

async function step(name, fn) {
	if(results.some(r => r.status === 'FAIL')) {
		results.push({ name, status: 'SKIP', note: 'an earlier step failed' })
		console.log(`SKIP  ${name}`)
		return
	}

	try {
		const note = await fn()
		results.push({ name, status: 'PASS', note })
		console.log(`PASS  ${name}${note ? `  (${note})` : ''}`)
	} catch(e) {
		results.push({ name, status: 'FAIL', note: e.message })
		console.log(`FAIL  ${name}\n      ${e.message}`)
	}
}

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
	if(r.status !== 0) {
		throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`)
	}

	return r.stdout
}

// async: the stub appstore/auth lives in THIS process, so a sync spawn would block it
function exec(cmd, args, opts = {}) {
	return new Promise(res => {
		const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = '', stderr = ''
		const t = setTimeout(() => c.kill('SIGKILL'), 90_000)
		c.stdout.on('data', d => stdout += d)
		c.stderr.on('data', d => stderr += d)
		c.on('close', status => { clearTimeout(t); res({ status, stdout, stderr }) })
	})
}

function start(name, cmd, args, opts) {
	const log = join(tmp, `${name}.log`)
	const out = []
	const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
	const keep = d => { out.push(d); writeFileSync(log, Buffer.concat(out)) }
	child.stdout.on('data', keep)
	child.stderr.on('data', keep)
	children.push(child)
	return { child, log }
}

const tail = (file, n = 12) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n      ') : '')

async function waitFor(what, fn, ms = 60_000) {
	const end = Date.now() + ms
	let last
	while(Date.now() < end) {
		try {
			const v = await fn()
			if(v) { return v }
		} catch(e) { last = e }
		await sleep(500)
	}

	throw new Error(`${what} did not become ready${last ? ` (${last.message})` : ''}`)
}

// ---- tokens: real ES256 JWTs, verified by bots (PUBLIC_KEY) and the app (CHATDADDY_PUBLIC_KEY) ----
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' })
const { Scope, generateBinaryString } = bots('@chatdaddy/client')
const ALL_SCOPES = generateBinaryString(Object.values(Scope))
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
function jwt(user, scope = ALL_SCOPES) {
	const now = Math.floor(Date.now() / 1000)
	const head = b64({ alg: 'ES256', typ: 'JWT' })
	const body = b64({ user, scope, iat: now, exp: now + 3600 })
	const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
	return `${head}.${body}.${sig.toString('base64url')}`
}

// ---- stub appstore + auth (bots hardcodes https://api.chatdaddy.tech; preload.cjs points it here) ----
const apps = new Map() // appId -> { versions: [] }
const stubCalls = []
const SERVICE_TEAM_ID = JSON.parse(readFileSync(join(BOTS_DIR, 'src/config.json'), 'utf8')).SERVICE_TEAM_ID
function startStub(port) {
	const server = http.createServer(async(rq, rs) => {
		const chunks = []
		for await (const c of rq) { chunks.push(c) }
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
		const u = new URL(rq.url, 'http://x')
		const reply = (status, json) => { rs.writeHead(status, { 'content-type': 'application/json' }); rs.end(JSON.stringify(json)) }
		stubCalls.push(`${rq.method} ${u.pathname}`)
		if(!rq.headers.authorization?.startsWith('Bearer ') && u.pathname !== '/auth/token') {
			return reply(401, { message: 'no bearer' })
		}

		let m
		if(rq.method === 'POST' && u.pathname === '/auth/token') { // bots' service token
			return reply(200, { access_token: jwt({ id: randomUUID(), teamId: SERVICE_TEAM_ID, fullName: 'svc' }) })
		}

		if(rq.method === 'POST' && u.pathname === '/auth/token/app') { // appAccessTokenPost
			const { teamId, installationId, appId } = body
			return reply(200, { access_token: jwt({
				id: randomUUID(), teamId, fullName: 'app',
				metadata: { type: 'app', objectId: `app_${appId}/inst_${installationId}` }
			}) })
		}

		if((m = /^\/appstore\/apps\/([^/]+)$/.exec(u.pathname)) && rq.method === 'GET') {
			return apps.has(m[1]) ? reply(200, { id: m[1] }) : reply(404, { message: 'not found' })
		}

		if(rq.method === 'POST' && u.pathname === '/appstore/apps') {
			apps.set(body.id, { versions: [] })
			return reply(200, { id: body.id })
		}

		if((m = /^\/appstore\/apps\/([^/]+)\/versions$/.exec(u.pathname))) {
			const app = apps.get(m[1])
			if(!app) { return reply(404, { message: 'not found' }) }
			if(rq.method === 'POST') {
				if(app.versions.some(v => v.version === body.version)) { return reply(409, { message: 'exists' }) }
				const item = { id: app.versions.length + 1, appId: m[1], version: body.version, manifestSchemaVersion: 1, createdAt: new Date().toISOString(), manifest: body.manifest, handlerType: body.manifest?.handler?.type }
				app.versions.unshift(item)
				return reply(200, item)
			}

			return reply(200, { items: app.versions })
		}

		return reply(404, { message: `stub: ${rq.method} ${u.pathname}` })
	})
	return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)))
}

// ---- helpers for calling things ----
const j = async(url, init = {}) => {
	const res = await fetch(url, init)
	const text = await res.text()
	let json
	try { json = JSON.parse(text) } catch {}
	return { status: res.status, json, text }
}

async function cleanup() {
	for(const c of children) { try { c.kill('SIGTERM') } catch {} }
	await sleep(500)
	for(const fn of cleanups.reverse()) { try { await fn() } catch {} }
	rmSync(tmp, { recursive: true, force: true })
}

for(const ev of ['uncaughtException', 'unhandledRejection']) {
	process.on(ev, async e => { console.error(`FATAL ${e?.message || e}`); await cleanup(); process.exit(1) })
}

process.on('SIGINT', async() => { await cleanup(); process.exit(130) })

// =====================================================================================================
const ctx = {}
console.log(`e2e-local run ${RUN}: bots ${BOTS_DIR}`)

try {
	// ---- 1. bots + Postgres ----
	await step('1a. Postgres database of its own created, bots migrations ran', async() => {
		if(await new Promise(r => net.connect(BOTS_PORT, '127.0.0.1').on('connect', function() { this.destroy(); r(true) }).on('error', () => r(false)))) {
			throw new Error(`port ${BOTS_PORT} is in use (bots has a fixed port)`)
		}

		const pg = bots('pg')
		const admin = new pg.Client({ connectionString: `${PG_URL}/postgres` })
		await admin.connect()
		await admin.query(`CREATE DATABASE ${DB}`)
		await admin.end()
		cleanups.push(async() => {
			const a = new pg.Client({ connectionString: `${PG_URL}/postgres` })
			await a.connect(); await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await a.end()
		})
		ctx.dbUri = `${PG_URL}/${DB}`
		ctx.pg = pg
		run('node', [join(BOTS_DIR, 'node_modules/.bin/rest-api-builder'), 'migrate'], {
			cwd: BOTS_DIR, env: { ...process.env, DB_URI: ctx.dbUri, NODE_ENV: 'development' }
		})
		return 'database created, migrations ran'
	})

	// ---- 2. KMS (localstack) ----
	await step('2a. localstack KMS is up and a key exists', async() => {
		const lsPort = await freePort()
		run('docker', ['run', '-d', '--rm', '--name', LS_NAME, '-p', `127.0.0.1:${lsPort}:4566`, '-e', 'SERVICES=kms',
			process.env.LOCALSTACK_IMAGE || 'localstack/localstack:3.8'])
		cleanups.push(() => run('docker', ['rm', '-f', LS_NAME]))
		const endpoint = `http://127.0.0.1:${lsPort}`
		await waitFor('localstack', async() => (await j(`${endpoint}/_localstack/health`)).json?.services?.kms)
		const { KMSClient, CreateKeyCommand } = bots('@aws-sdk/client-kms')
		const kms = new KMSClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
		ctx.kmsKeyId = (await kms.send(new CreateKeyCommand({}))).KeyMetadata.KeyId
		// the standard endpoint env var, NOT a code change: connection-crypto.ts does `new KMSClient({})`
		ctx.awsEnv = {
			AWS_ENDPOINT_URL_KMS: endpoint, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
			APP_CONNECTIONS_KMS_KEY_ID: ctx.kmsKeyId
		}
	})

	// shared env and process starters, once the above exist
	const stubPort = await freePort()
	const appPort = await freePort()
	const proxyPort = await freePort()
	const stub = await startStub(stubPort)
	cleanups.push(() => stub.close())
	const certKey = join(tmp, 'key.pem'), certPem = join(tmp, 'cert.pem')
	let botsEnv
	const probe = async(mode, arg) => {
		const r = await exec('node', ['-r', '@swc-node/register', '-r', join(here, 'preload.cjs'), join(here, 'bots-probe.cjs'), mode, ...(arg ? [arg] : [])],
			{ cwd: BOTS_DIR, env: botsEnv })
		const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT:'))
		if(!line) { throw new Error(`probe ${mode} gave no result: ${(r.stderr || '').trim().split('\n').slice(-2).join(' | ')}`) }
		ctx.probeOut = r.stdout
		return JSON.parse(line.slice(7))
	}

	await step('1b. bots server boots and authenticates a real ES256 token', async() => {
		run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', certKey, '-out', certPem,
			'-days', '1', '-subj', `/CN=${APP_HOST}`, '-addext', `subjectAltName=DNS:${APP_HOST}`], { stdio: 'pipe' })
		ctx.baseUrl = `https://${APP_HOST}:${proxyPort}`
		botsEnv = {
			...process.env, ...ctx.awsEnv,
			NODE_ENV: 'development', DB_URI: ctx.dbUri, ...(process.env.AMQP_URI ? { AMQP_URI: process.env.AMQP_URI } : {}), PUBLIC_KEY: PUBLIC_PEM, SERVICE_REFRESH_TOKEN: dummy(),
			BOTS_DIR, E2E_STUB_URL: `http://127.0.0.1:${stubPort}`, E2E_APP_HOST: APP_HOST, NODE_EXTRA_CA_CERTS: certPem,
		}
		const b = start('bots', 'node', ['-r', '@swc-node/register', '-r', join(here, 'preload.cjs'), 'src/start-server.ts'], { cwd: BOTS_DIR, env: botsEnv })
		ctx.botsLog = b.log
		ctx.teamId = randomUUID()
		ctx.userToken = jwt({ id: randomUUID(), teamId: ctx.teamId, fullName: 'E2E Admin' })
		try {
			await waitFor('bots', async() => (await j(`http://127.0.0.1:${BOTS_PORT}/bots/installations`, {
				headers: { authorization: `Bearer ${ctx.userToken}` }
			})).status === 200, 90_000)
		} catch(e) {
			throw new Error(`${e.message}\n      ${tail(b.log)}`)
		}

		return 'GET /bots/installations answered 200 for a real ES256 token (PUBLIC_KEY env)'
	})

	await step('2b. bots seals and opens a secret via connection-crypto, endpoint set by env only', async() => {
		const kms = await probe('kms')
		if(!kms.roundTrip) { throw new Error(`KMS seal/open through bots code failed: ${JSON.stringify(kms)}`) }
		return 'AWS_ENDPOINT_URL_KMS honoured by new KMSClient({})'
	})

	// ---- 3. the app ----
	await step('3. Shopify app runs locally behind HTTPS and answers /healthz', async() => {
		const appEnv = {
			WEBHOOK_SECRET_KEY: randomBytes(32).toString('hex'), ADMIN_TOKEN, CHATDADDY_PUBLIC_KEY: PUBLIC_PEM,
		}
		let a
		if(process.env.APP_DOCKER_DIR) {
			// APP_DOCKER_DIR: a dir with the example's Dockerfile (PR #6): build it, run it as the container the runbook describes
			const image = `e2e-local-app-${RUN}`
			run('docker', ['build', '-q', '-t', image, process.env.APP_DOCKER_DIR])
			cleanups.push(() => run('docker', ['rmi', '-f', image]))
			const name = `e2e-local-app-${RUN}`
			const envArgs = Object.entries({ ...appEnv, CHATDADDY_BOTS_URL: `http://127.0.0.1:${BOTS_PORT}/bots`, PORT: String(appPort) }).flatMap(([k, v]) => ['-e', `${k}=${v}`])
			a = start('app', 'docker', ['run', '--rm', '--name', name, '--network', 'host', ...envArgs, image], {}) // host network (Linux): docker0 -> host is often firewalled
			cleanups.push(() => run('docker', ['rm', '-f', name]))
		} else {
			a = start('app', 'node', ['src/main.mjs'], {
				cwd: join(repo, 'examples/shopify-order'),
				env: { PATH: process.env.PATH, ...appEnv, PORT: String(appPort), CHATDADDY_BOTS_URL: `http://127.0.0.1:${BOTS_PORT}/bots`, DATA_FILE: join(tmp, 'installations.json') }
			})
		}

		ctx.appLog = a.log
		// the "public HTTPS" in front of the container: a TLS terminator with a self-signed cert for the fake host
		const proxy = https.createServer({ key: readFileSync(certKey), cert: readFileSync(certPem) }, (rq, rs) => {
			const up = http.request({ host: '127.0.0.1', port: appPort, method: rq.method, path: rq.url, headers: rq.headers }, ur => {
				rs.writeHead(ur.statusCode, ur.headers); ur.pipe(rs)
			})
			up.on('error', () => { rs.writeHead(502); rs.end() })
			rq.pipe(up)
		})
		await new Promise(r => proxy.listen(proxyPort, '127.0.0.1', r))
		cleanups.push(() => proxy.close())
		const health = await waitFor('app /healthz over TLS', () => new Promise((res, rej) => {
			https.get({ host: '127.0.0.1', port: proxyPort, path: '/healthz', servername: APP_HOST, ca: readFileSync(certPem), headers: { host: APP_HOST } },
				r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(d)) }).on('error', rej)
		}), 20_000)
		if(health !== '{"ok":true}') { throw new Error(`healthz said ${health}`) }
		return `${process.env.APP_DOCKER_DIR ? 'Docker image' : 'node src/main.mjs'} behind a self-signed TLS terminator`
	})

	// ---- 2b/4 publish to the stub appstore, then install ----
	await step('4a. publish the manifest (create-chatdaddy-app publish, against the stub appstore)', async() => {
		// PUBLISH_CLI: a create-chatdaddy-app.mjs that has `publish` (PR #6), if this checkout predates it
		const cli = process.env.PUBLISH_CLI || join(repo, 'packages/create-chatdaddy-app/bin/create-chatdaddy-app.mjs')
		const hasPublish = existsSync(join(dirname(cli), '../src/publish.mjs'))
		const manifestFile = join(repo, 'examples/shopify-order/chatdaddy-app.json')
		if(hasPublish) {
			const r = await exec('node', [cli, 'publish', manifestFile, '--version', VERSION, '--base-url', ctx.baseUrl], {
				env: { PATH: process.env.PATH, CHATDADDY_TOKEN: jwt({ id: randomUUID(), teamId: ctx.teamId, fullName: 'dev' }), CHATDADDY_APPSTORE_URL: `http://127.0.0.1:${stubPort}/appstore` }
			})
			if(r.status !== 0) { throw new Error(`publish exited ${r.status}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`) }
			return r.stdout.split('\n').filter(l => /^(registered|published|app )/.test(l)).join('; ')
		}

		// no publish command in this checkout of chatdaddy-apps (PR #6 not merged): register what it would send
		const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
		manifest.handler.baseUrl = ctx.baseUrl
		apps.set(APP_ID, { versions: [{ appId: APP_ID, version: VERSION, manifest, handlerType: 'url' }] })
		return 'publish command not in this checkout; stub registered the same manifest directly'
	})

	await step('4b. install through bots POST /installations, then the handshake completes (bots -> POST /installed -> ack)', async() => {
		const inst = await j(`http://127.0.0.1:${BOTS_PORT}/bots/installations`, {
			method: 'POST',
			headers: { authorization: `Bearer ${ctx.userToken}`, 'content-type': 'application/json' },
			body: JSON.stringify({ appId: APP_ID, appVersion: VERSION, grantedScopes: ['ACCOUNT_READ'], settings: { storeName: 'E2E Store' } })
		})
		if(inst.status !== 200) { throw new Error(`install answered ${inst.status} ${inst.text.slice(0, 200)}`) }
		ctx.installationId = inst.json.id
		if(inst.json.status !== 'pending-handshake') { throw new Error(`new installation is ${inst.json.status}`) }
		const hs = await probe('handshake')
		if(!hs.ran) { throw new Error(`handshake job: ${JSON.stringify(hs)}`) }
		const list = await j(`http://127.0.0.1:${BOTS_PORT}/bots/installations`, { headers: { authorization: `Bearer ${ctx.userToken}` } })
		const mine = (list.json?.items || list.json || []).find?.(i => i.id === ctx.installationId)
		if(mine?.status !== 'active') {
			throw new Error(`installation is ${mine?.status} after the handshake job\n      job log: ${(ctx.probeOut || '').split('\n').filter(l => /handshake/.test(l)).slice(-3).join('\n      ')}`)
		}

		return 'pending-handshake -> active; app held the secret and returned a valid ack'
	})

	// ---- 5. secret + signed webhook ----
	await step('5. paste the shop webhook secret, send an HMAC-signed orders/create webhook', async() => {
		const app = `http://127.0.0.1:${appPort}`
		const wrong = await j(`${app}/installations/${ctx.installationId}/shopify-webhook-secret`, {
			method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{"secret":"x"}'
		})
		if(wrong.status !== 401) { throw new Error(`wrong admin token answered ${wrong.status}`) }
		const set = await j(`${app}/installations/${ctx.installationId}/shopify-webhook-secret`, {
			method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ secret: SHOP_SECRET })
		})
		if(set.status !== 200 || set.json?.ok !== true) { throw new Error(`secret route answered ${set.status} ${set.text}`) }

		ctx.eventId = `e2e-${randomBytes(6).toString('hex')}`
		const order = JSON.stringify({
			id: 820982911946154508, order_number: 1001, total_price: '42.00', currency: 'USD',
			customer: { first_name: 'Test', last_name: 'Buyer', phone: '+15555550100' },
			line_items: [{ title: 'Widget', quantity: 2 }, { title: 'Gadget', quantity: 1 }]
		})
		const hook = (hmacKey, id) => j(`${app}/shopify/webhook/${ctx.installationId}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json', 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': id,
				'x-shopify-hmac-sha256': createHmac('sha256', hmacKey).update(order).digest('base64'),
			},
			body: order
		})
		const bad = await hook('not-the-secret', 'e2e-bad')
		if(bad.status !== 401) { throw new Error(`bad HMAC answered ${bad.status}`) }
		const good = await hook(SHOP_SECRET, ctx.eventId)
		if(good.status !== 200 || good.json?.forwarded !== true) {
			throw new Error(`signed webhook answered ${good.status} ${good.text}\n      bots: ${tail(ctx.botsLog, 6)}`)
		}

		return 'bad HMAC 401, good HMAC 200 {forwarded:true}'
	})

	// ---- 6. trigger ingest + action ----
	await step('6a. bots trigger ingest accepted the app-signed trigger', async() => {
		const pg = new ctx.pg.Client({ connectionString: ctx.dbUri })
		await pg.connect()
		const { rows } = await pg.query('SELECT "eventId" FROM trigger_event_seen WHERE "installationId" = $1', [ctx.installationId])
		await pg.end()
		if(!rows.some(r => r.eventId === ctx.eventId)) { throw new Error('bots has no replay row for the delivery (it was not accepted)') }
		return 'replay row recorded (signature verified, payload matched payloadSchema). No flow is bound, so nothing fired'
	})

	await step('6b. bots calls the app action format-order-message and gets { message } back', async() => {
		const input = { orderId: '1001', customerName: 'Test Buyer', total: '42.00', currency: 'USD', itemsSummary: '2 x Widget, 1 x Gadget' }
		const out = await probe('action', JSON.stringify({ teamId: ctx.teamId, appId: APP_ID, actionId: 'format-order-message', input }))
		if(out.error || out.statusCode !== 200 || typeof out.body?.message !== 'string') {
			throw new Error(`action result ${JSON.stringify(out)}\n      bots: ${tail(ctx.botsLog, 6)}`)
		}

		return `message: "${out.body.message.slice(0, 80).replace(/\n/g, ' ')}"`
	})

	console.log('\n7. STOPPED before any send. In a real flow the next step is the WhatsApp send, reached from bots\' flow runner')
	console.log('   (src/utils/app-utils.ts getOutputFromApp -> the send action). Nothing here talks to IM or WhatsApp.')
} finally {
	await cleanup()
}

console.log('\nsummary')
for(const r of results) { console.log(`  ${r.status.padEnd(4)} ${r.name}`) }
process.exit(results.some(r => r.status === 'FAIL') ? 1 : 0)
