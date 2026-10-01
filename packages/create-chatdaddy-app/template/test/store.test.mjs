import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { INST_A, INST_B, startApp } from './helpers.mjs'
import { InstallationStore, PREVIOUS_SECRET_WINDOW_S } from '../src/store.mjs'

test('a re-handshake with a new secret keeps the old one for the window only', async() => {
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

test('secrets are per installation, and unknown installations (even prototype names) have none', async() => {
	const app = await startApp()
	try {
		await app.handshake('whsec_a')
		await app.handshake('whsec_b', { installationId: INST_B, nonce: 'n-b' })
		assert.deepEqual(app.store.secretsFor(INST_A, app.clock.t), ['whsec_a'])
		assert.deepEqual(app.store.secretsFor(INST_B, app.clock.t), ['whsec_b'])
		assert.deepEqual(app.store.secretsFor('33333333-3333-4333-8333-333333333333', app.clock.t), [])
		assert.deepEqual(app.store.secretsFor('constructor', app.clock.t), [])
		assert.equal(app.store.currentSecret('__proto__'), undefined)
	} finally {
		await app.close()
	}
})

test('an oversized handshake body is refused with 413', async() => {
	const app = await startApp()
	try {
		const res = await app.post('/installed', 'x'.repeat(70 * 1024), { authorization: 'Bearer a.b.c' })
		assert.equal(res.status, 413)
	} finally {
		await app.close()
	}
})

test('the file store persists across a reload, and the file is private (0600)', async() => {
	const file = join(mkdtempSync(join(tmpdir(), 'cd-store-')), 'data', 'installations.json')
	const store = new InstallationStore(file)
	await store.saveHandshake({ installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 's1' }, 1000)
	assert.equal(statSync(file).mode & 0o777, 0o600)
	const again = await new InstallationStore(file).load()
	assert.deepEqual(again.get(INST_A), { installationId: INST_A, teamId: 't', appId: 'a', signingSecret: 's1' })
	assert.ok(readFileSync(file, 'utf8').includes('s1'))
})
