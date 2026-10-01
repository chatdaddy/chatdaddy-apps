import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { BIN, close, listen, scaffold } from './helpers.mjs'
import { checkProperties } from '../src/dev/props.mjs'
import { tokenize } from '../src/dev/repl.mjs'
import { DevError, createDevSession } from '../src/dev/session.mjs'
import { createTriggerServer } from '../src/dev/trigger-server.mjs'
import { computeHandshakeAck, signAppToBots, signBotsToApp, verifyBotsToApp } from '../template/src/signing.mjs'

const manifestOf = dir => JSON.parse(readFileSync(join(dir, 'chatdaddy-app.json'), 'utf8'))

/** the scaffolded app, started in-process, trusting a dev key supplied lazily */
async function startScaffoldApp(app, getPublicKey) {
	const store = new app.store.InstallationStore(undefined)
	const server = app.server.createApp({ appId: manifestOf(app.dir).id, getPublicKey, store })
	const url = await listen(server)
	return { store, server, url }
}

/** the full loop: handshake -> action call -> trigger delivery */
async function fullLoop() {
	const app = await scaffold()
	const manifest = manifestOf(app.dir)
	let session
	const running = await startScaffoldApp(app, () => app.keys.createKeyResolver({ CHATDADDY_DEV_PUBLIC_KEY: session.publicKeyPem })())
	session = createDevSession({ manifest, appUrl: running.url })
	const triggers = createTriggerServer({ session })
	const port = await triggers.listen(0)
	return {
		app, manifest, session, running, botsUrl: `http://127.0.0.1:${port}`,
		stop: async() => {
			await triggers.close()
			await close(running.server)
			app.cleanup()
		},
	}
}

test('full loop: handshake, action call, trigger delivery, all verified', async() => {
	const t = await fullLoop()
	try {
		// handshake: the app verified our ES256 token, stored the secret, and acked correctly
		await t.session.handshake()
		assert.equal(t.session.installed, true)
		const rec = t.running.store.get(t.session.installationId)
		assert.equal(rec.signingSecret, t.session.signingSecret)
		assert.equal(rec.teamId, t.session.teamId)
		assert.equal(rec.appId, t.manifest.id)

		// action: signed bots-to-app request, validated against outputProperties
		const call = await t.session.call('shout', { text: 'hello' })
		assert.equal(call.status, 200)
		assert.equal(call.ok, true, JSON.stringify(call))
		assert.deepEqual(call.body, { result: 'HELLO', length: 5 })
		assert.deepEqual(call.problems, [])

		// the app's own error path surfaces as a failed call, not an exception
		const bad = await t.session.call('shout', {})
		assert.equal(bad.status, 400)
		assert.equal(bad.ok, false)
		assert.ok(bad.warnings.some(w => w.includes('input.text: required but missing')))

		// trigger: the scaffold's own sendTrigger helper, pointed at the dev endpoint
		const secret = t.running.store.currentSecret(t.session.installationId)
		const send = (over = {}) => t.app.trigger.sendTrigger({
			botsUrl: t.botsUrl, installationId: t.session.installationId, triggerId: 'example-event',
			payload: { message: 'hi', phone: '+100' }, secret, eventId: 'evt-1', ...over,
		})
		const ok = await send()
		assert.equal(ok.status, 202)
		assert.deepEqual(JSON.parse(ok.body), { fired: 1, throttled: 0, failed: 0 })
		assert.deepEqual(t.session.fired, [{ triggerId: 'example-event', eventId: 'evt-1', payload: { message: 'hi', phone: '+100' } }])

		// the same event id again: acknowledged, not fired twice
		const dup = await send()
		assert.equal(dup.status, 200)
		assert.deepEqual(JSON.parse(dup.body), { duplicate: true })
		assert.equal(t.session.fired.length, 1)
		// the event id alone decides: a repeat with a different payload is still a duplicate
		const repeatNewPayload = await t.app.trigger.sendTrigger({
			botsUrl: t.botsUrl, installationId: t.session.installationId, triggerId: 'example-event',
			payload: { message: 'again', phone: '+100' }, secret, eventId: 'evt-1',
		})
		assert.equal(repeatNewPayload.status, 200)

		// a new event id fires again
		assert.equal((await send({ eventId: 'evt-2' })).status, 202)
		assert.equal(t.session.fired.length, 2)
	} finally {
		await t.stop()
	}
})

test('trigger endpoint refuses what ChatDaddy refuses', async() => {
	const t = await fullLoop()
	try {
		await t.session.handshake()
		const secret = t.session.signingSecret
		const inst = t.session.installationId
		const post = (path, body, headers) => fetch(`${t.botsUrl}${path}`, { method: 'POST', body, headers })
		const url = (i = inst, trig = 'example-event') => `/apps/triggers/${i}/${trig}`
		const good = JSON.stringify({ message: 'x' })
		const hdr = (eventId = 'e1', body = good, sec = secret, ts) => ({
			'x-chatdaddy-event-id': eventId, 'x-chatdaddy-signature': signAppToBots(sec, eventId, body, ts),
		})
		const status = async(...a) => (await post(...a)).status

		assert.equal(await status(url(), good, hdr('ok-1')), 202)
		assert.equal(await status(url(), good, hdr('e2', good, 'whsec_wrong')), 401, 'wrong secret')
		assert.equal(await status(url(), good, hdr('e3', '{"message":"other"}')), 401, 'signature over different body')
		assert.equal(await status(url(), good, { ...hdr('e4'), 'x-chatdaddy-event-id': 'e5' }), 401, 'event id not bound')
		assert.equal(await status(url(), good, hdr('e6', good, secret, Math.floor(Date.now() / 1000) - 1000)), 401, 'stale timestamp')
		assert.equal(await status(url(), good, {}), 400, 'no event id')
		assert.equal(await status(url(), good, { 'x-chatdaddy-event-id': 'a.b', 'x-chatdaddy-signature': 't=1,v1=00' }), 400, 'dot in event id')
		assert.equal(await status(url('99999999-9999-4999-8999-999999999999'), good, hdr('e7')), 404, 'unknown installation')
		assert.equal(await status(url(inst, 'nope'), good, hdr('e8')), 404, 'undeclared trigger')
		assert.equal(await status(url(), 'not json', hdr('e9', 'not json')), 400, 'invalid json')
		assert.equal(await status(url(), '[1]', hdr('e10', '[1]')), 400, 'not an object')
		const missing = JSON.stringify({ phone: '1' })
		const res = await post(url(), missing, hdr('e11', missing))
		assert.equal(res.status, 400, 'payloadSchema: required message missing')
		assert.match(await res.text(), /payloadSchema.*message/)
		const wrongType = JSON.stringify({ message: 5 })
		assert.equal(await status(url(), wrongType, hdr('e12', wrongType)), 400, 'payloadSchema: wrong type')
		const big = JSON.stringify({ message: 'x'.repeat(70_000) })
		assert.equal(await status(url(), big, hdr('e13', big)), 413, 'over 64 KB')
		assert.equal(await status('/elsewhere', good, hdr()), 404)
		assert.equal(t.session.fired.length, 1, 'only the first, valid delivery fired')
	} finally {
		await t.stop()
	}
})

test('a body that is not a JSON object is refused even when the payloadSchema says nothing', async() => {
	const manifest = { id: 'x', flowTriggers: [{ id: 'loose', title: 'Loose', payloadSchema: {} }] }
	const session = createDevSession({ manifest, appUrl: 'http://127.0.0.1:1' })
	session.installed = true
	const triggers = createTriggerServer({ session })
	const port = await triggers.listen(0)
	try {
		const send = async(body, eventId) => (await fetch(`http://127.0.0.1:${port}/apps/triggers/${session.installationId}/loose`, {
			method: 'POST', body, headers: { 'x-chatdaddy-event-id': eventId, 'x-chatdaddy-signature': signAppToBots(session.signingSecret, eventId, body) },
		})).status
		assert.equal(await send('[1]', 'a'), 400)
		assert.equal(await send('null', 'b'), 400)
		assert.equal(await send('"s"', 'c'), 400)
		assert.equal(await send('{"anything":1}', 'd'), 202)
	} finally {
		await triggers.close()
	}
})

test('trigger endpoint refuses deliveries before the app is installed', async() => {
	const app = await scaffold()
	const session = createDevSession({ manifest: manifestOf(app.dir), appUrl: 'http://127.0.0.1:1' })
	const triggers = createTriggerServer({ session })
	const port = await triggers.listen(0)
	try {
		const body = '{"message":"x"}'
		const res = await fetch(`http://127.0.0.1:${port}/apps/triggers/${session.installationId}/example-event`, {
			method: 'POST', body, headers: { 'x-chatdaddy-event-id': 'e', 'x-chatdaddy-signature': signAppToBots(session.signingSecret, 'e', body) },
		})
		assert.equal(res.status, 404)
		assert.equal(session.fired.length, 0)
	} finally {
		await triggers.close()
		app.cleanup()
	}
})

test('an app that trusts only ChatDaddy\'s real key rejects the dev token (and dev says why)', async() => {
	const app = await scaffold()
	const running = await startScaffoldApp(app, app.keys.createKeyResolver({}))
	try {
		const session = createDevSession({ manifest: manifestOf(app.dir), appUrl: running.url })
		await assert.rejects(session.handshake(), err => err instanceof DevError && /401.*dev token.*CHATDADDY_DEV_PUBLIC_KEY_FILE/.test(err.message))
		assert.equal(session.installed, false)
		assert.equal(running.store.get(session.installationId), undefined)
	} finally {
		await close(running.server)
		app.cleanup()
	}
})

test('the dev key is refused when NODE_ENV=production (resolver, and the real start-up)', async() => {
	const app = await scaffold()
	try {
		const session = createDevSession({ manifest: manifestOf(app.dir), appUrl: 'http://127.0.0.1:1' })
		assert.throws(
			() => app.keys.createKeyResolver({ NODE_ENV: 'production', CHATDADDY_DEV_PUBLIC_KEY: session.publicKeyPem }),
			/Refusing to start/
		)
		// the actual entry point: exits 1, never listens
		const r = spawnSync(process.execPath, [join(app.dir, 'src', 'main.mjs')], {
			cwd: app.dir, encoding: 'utf8', timeout: 10_000,
			env: { PATH: process.env.PATH, NODE_ENV: 'production', CHATDADDY_DEV_PUBLIC_KEY: session.publicKeyPem, PORT: '0', DATA_FILE: join(app.dir, 'd.json') },
		})
		assert.equal(r.status, 1, r.stdout + r.stderr)
		assert.match(r.stderr, /Refusing to start/)
		assert.ok(!r.stdout.includes('listening'))
		// and WITHOUT the dev key, production starts normally (killed by timeout, so signal)
		const ok = spawnSync(process.execPath, ['-e', `
			import(${JSON.stringify(join(app.dir, 'src', 'keys.mjs'))}).then(m => { m.createKeyResolver({ NODE_ENV: 'production' }); console.log('fine') })`], { encoding: 'utf8' })
		assert.match(ok.stdout, /fine/)
	} finally {
		app.cleanup()
	}
})

/** a fake app: lets a test script exactly what the app answers */
async function fakeApp(handler) {
	const calls = []
	const server = createServer(async(req, res) => {
		const chunks = []
		for await (const c of req) {
			chunks.push(c)
		}

		const raw = Buffer.concat(chunks).toString('utf8')
		calls.push({ url: req.url, headers: req.headers, raw })
		const out = handler({ url: req.url, headers: req.headers, raw }, calls.length)
		res.writeHead(out.status ?? 200, { 'content-type': 'application/json' })
		res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body))
	})
	return { url: await listen(server), calls, close: () => close(server) }
}

const MANIFEST = {
	id: 'fake', scopes: ['ACCOUNT_READ'],
	flowActions: [{
		id: 'act', title: 'Act',
		inputProperties: [{ propertyPath: 'n', title: 'N', type: 'number', required: true }],
		outputProperties: [
			{ propertyPath: 's', title: 'S', type: 'string', required: true },
			{ propertyPath: 'tags', title: 'T', type: 'array', required: false, items: { type: 'string' } },
		],
	}],
}

test('dev signs action calls byte-for-byte as ChatDaddy does', async() => {
	const T = 1700000000
	const app = await fakeApp(({ url }) => (url === '/installed' ? { body: { ack: 'x' } } : { body: { s: 'ok' } }))
	try {
		const session = createDevSession({ manifest: MANIFEST, appUrl: app.url, now: () => T })
		session.installed = true
		const r = await session.call('act', { n: 1 }, { settings: { a: 1 } })
		assert.equal(r.ok, true)
		const sent = app.calls[0]
		assert.equal(sent.url, '/actions/act')
		assert.equal(sent.headers['x-chatdaddy-installation'], session.installationId)
		assert.equal(sent.headers['x-chatdaddy-signature'], signBotsToApp(session.signingSecret, sent.raw, T))
		assert.equal(verifyBotsToApp(session.signingSecret, sent.raw, sent.headers['x-chatdaddy-signature'], T), true)
		assert.deepEqual(JSON.parse(sent.raw), {
			input: { n: 1 }, context: { teamId: 'dev-team', installationId: session.installationId }, settings: { a: 1 },
		})
	} finally {
		await app.close()
	}
})

test('dev signs the install token with ES256 and sends the handshake body ChatDaddy sends', async() => {
	const { createPublicKey, verify } = await import('node:crypto')
	const app = await fakeApp(({ raw }) => ({ body: { ack: computeHandshakeAck(JSON.parse(raw).signingSecret, JSON.parse(raw).nonce) } }))
	try {
		const session = createDevSession({ manifest: MANIFEST, appUrl: app.url })
		await session.handshake()
		const { headers, raw } = app.calls[0]
		const body = JSON.parse(raw)
		assert.deepEqual(Object.keys(body).sort(), ['appId', 'appVersion', 'grantedScopes', 'installationId', 'nonce', 'signingSecret', 'teamId'])
		assert.deepEqual(body.grantedScopes, ['ACCOUNT_READ'])
		const [h, p, s] = headers.authorization.slice('Bearer '.length).split('.')
		assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'ES256')
		assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: createPublicKey(session.publicKeyPem), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true)
		const claims = JSON.parse(Buffer.from(p, 'base64url'))
		assert.deepEqual(claims.user.metadata, { type: 'app', objectId: `app_fake/inst_${body.installationId}` })
		assert.equal(claims.user.teamId, body.teamId)
		assert.ok(claims.exp > Date.now() / 1000)
	} finally {
		await app.close()
	}
})

test('dev checks the ack, the status and the output shape', async() => {
	// wrong ack
	let app = await fakeApp(() => ({ body: { ack: 'deadbeef' } }))
	await assert.rejects(createDevSession({ manifest: MANIFEST, appUrl: app.url }).handshake(), /ack is missing or wrong/)
	await app.close()
	// no ack at all, non-JSON body
	app = await fakeApp(() => ({ body: 'not json' }))
	await assert.rejects(createDevSession({ manifest: MANIFEST, appUrl: app.url }).handshake(), /ack is missing or wrong/)
	await app.close()
	// 500
	app = await fakeApp(() => ({ status: 500, body: { error: 'boom' } }))
	await assert.rejects(createDevSession({ manifest: MANIFEST, appUrl: app.url }).handshake(), /expected 200, got 500/)
	await app.close()
	// unreachable
	await assert.rejects(createDevSession({ manifest: MANIFEST, appUrl: 'http://127.0.0.1:1' }).handshake(), /cannot reach the app/)

	// output validation
	const outputs = [
		[{ s: 'a' }, true, []],
		[{ s: 'a', tags: ['x'] }, true, []],
		[{}, false, ['output.s: required but missing']],
		[{ s: 1 }, false, ['output.s: expected string, got number']],
		[{ s: 'a', tags: [1] }, false, ['output.tags[0]: expected string, got number']],
		[{ s: 'a', tags: 'x' }, false, ['output.tags: expected array, got string']],
		['text', false, ['output: expected a JSON object, got string']],
		[[1], false, ['output: expected a JSON object, got array']],
	]
	let current
	app = await fakeApp(() => ({ body: current }))
	try {
		const session = createDevSession({ manifest: MANIFEST, appUrl: app.url })
		session.installed = true
		for(const [body, ok, problems] of outputs) {
			current = body
			const r = await session.call('act', { n: 1 })
			assert.equal(r.ok, ok, JSON.stringify(body))
			assert.deepEqual(r.problems, problems, JSON.stringify(body))
		}

		current = { s: 'a', extra: 1 }
		assert.deepEqual((await session.call('act', { n: 1 })).warnings, ['output.extra: not declared in the manifest'])
		await assert.rejects(session.call('nope', {}), /no action "nope" in the manifest \(declared: act\)/)
		const fresh = createDevSession({ manifest: MANIFEST, appUrl: app.url })
		await assert.rejects(fresh.call('act', {}), /not installed yet/)
	} finally {
		await app.close()
	}
})

test('checkProperties and tokenize', () => {
	assert.deepEqual(checkProperties([{ propertyPath: 'a', type: 'boolean', required: true }], { a: true }, 'x'), { problems: [], warnings: [] })
	assert.deepEqual(checkProperties([{ propertyPath: 'a', type: 'number' }], { a: null }, 'x').problems, ['x.a: expected number, got null'])
	assert.deepEqual(tokenize(`call shout --input '{"text":"a b"}'`), ['call', 'shout', '--input', '{"text":"a b"}'])
	assert.deepEqual(tokenize('a  "b c"   \'\''), ['a', 'b c', ''])
	assert.deepEqual(tokenize('say "he said \\"hi\\""'), ['say', 'he said "hi"'])
	assert.throws(() => tokenize('a "b'), /unterminated/)
})

test('CLI: `dev` installs the app, runs a call from stdin, and exits at quit', async() => {
	const app = await scaffold()
	let keyFile
	let child
	const running = await startScaffoldApp(app, () => readFileSync(keyFile, 'utf8'))
	try {
		keyFile = join(app.dir, '.chatdaddy-dev', 'public-key.pem')
		child = spawn(process.execPath, [BIN, 'dev', '--app', running.url, '--port', '0', '--key-file', keyFile], { cwd: app.dir })
		let out = ''
		child.stdout.on('data', d => (out += d))
		child.stderr.on('data', d => (out += d))
		const waitFor = async re => {
			for(let i = 0; i < 200 && !re.test(out); i++) {
				await new Promise(r => setTimeout(r, 25))
			}

			assert.match(out, re)
		}

		await waitFor(/installed .*handshake accepted/)
		child.stdin.write(`call shout --input '{"text":"cli"}'\n`)
		await waitFor(/OK: response matches outputProperties/)
		assert.match(out, /200 \{"result":"CLI","length":3\}/)

		// fire a trigger at the port the REPL announced
		const port = /127\.0\.0\.1:(\d+)\/apps\/triggers\/([0-9a-f-]+)\//.exec(out)
		assert.ok(port, out)
		const secret = [...Object.values(running.store.records)][0].signingSecret
		const r = await app.trigger.sendTrigger({
			botsUrl: `http://127.0.0.1:${port[1]}`, installationId: port[2], triggerId: 'example-event', payload: { message: 'via cli' }, secret, eventId: 'cli-1',
		})
		assert.equal(r.status, 202)
		await waitFor(/WOULD FIRE example-event \(event cli-1\)/)
		child.stdin.write('call shout --input nonsense\ncall nope\nfrobnicate\ntriggers\nquit\n')
		const code = await new Promise(res => child.on('close', res))
		assert.equal(code, 0)
		assert.match(out, /error: --input is not valid JSON/)
		assert.match(out, /error: no action "nope"/)
		assert.match(out, /error: unknown command "frobnicate"/)
		assert.match(out, /example-event event cli-1 \{"message":"via cli"\}/)
		assert.ok(readFileSync(keyFile, 'utf8').includes('BEGIN PUBLIC KEY'))
		assert.ok(!readFileSync(keyFile, 'utf8').includes('PRIVATE'), 'the private key is never written')
	} finally {
		child?.kill() // a failed assertion must not leave the child holding the test run open
		await close(running.server)
		app.cleanup()
	}
})

test('CLI: `dev` reports a failed handshake and keeps going', async() => {
	const app = await scaffold()
	let child
	try {
		child = spawn(process.execPath, [BIN, 'dev', '--app', 'http://127.0.0.1:1', '--port', '0'], { cwd: app.dir })
		let out = ''
		child.stdout.on('data', d => (out += d))
		child.stdin.end('quit\n')
		assert.equal(await new Promise(res => child.on('close', res)), 0)
		assert.match(out, /handshake failed: cannot reach the app/)
	} finally {
		child?.kill()
		app.cleanup()
	}
})
