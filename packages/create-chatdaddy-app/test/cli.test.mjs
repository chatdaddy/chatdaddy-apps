import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { BIN, PKG, rmrf, tmp } from './helpers.mjs'
import { invalidManifestFixtures, validFullManifest } from './fixtures.mjs'
import { parseEventNames, parseScopes } from '../scripts/sync-scopes.mjs'

const run = (args, cwd) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd })

test('validate: exit 0 for a valid manifest, default path is ./chatdaddy-app.json', () => {
	const root = tmp()
	try {
		writeFileSync(join(root, 'chatdaddy-app.json'), JSON.stringify(validFullManifest))
		const r = run(['validate'], root)
		assert.equal(r.status, 0, r.stderr)
		assert.match(r.stdout, /chatdaddy-app\.json: valid/)
		writeFileSync(join(root, 'other.json'), JSON.stringify(validFullManifest))
		assert.equal(run(['validate', 'other.json'], root).status, 0)
	} finally {
		rmrf(root)
	}
})

test('validate: exit 1 and every error listed for an invalid manifest', () => {
	const root = tmp()
	try {
		const f = invalidManifestFixtures.find(x => x.rule === 'unknown scope')
		writeFileSync(join(root, 'm.json'), JSON.stringify(f.manifest))
		const r = run(['validate', 'm.json'], root)
		assert.equal(r.status, 1)
		assert.match(r.stderr, /INVALID, 1 problem/)
		assert.match(r.stderr, /unknown scope "NOT_A_REAL_SCOPE"/)
		// several problems at once are all reported
		writeFileSync(join(root, 'm2.json'), JSON.stringify({ ...validFullManifest, id: 'Bad Id', scopes: [], aiUse: 'x' }))
		const r2 = run(['validate', 'm2.json'], root)
		assert.equal(r2.status, 1)
		assert.ok(/[3-9] problems/.test(r2.stderr), r2.stderr)
	} finally {
		rmrf(root)
	}
})

test('validate: exit 2 for a missing file or invalid JSON', () => {
	const root = tmp()
	try {
		assert.equal(run(['validate', 'nope.json'], root).status, 2)
		writeFileSync(join(root, 'bad.json'), '{ not json')
		const r = run(['validate', 'bad.json'], root)
		assert.equal(r.status, 2)
		assert.match(r.stderr, /not valid JSON/)
	} finally {
		rmrf(root)
	}
})

test('help, version, unknown command, bad flags', () => {
	const help = run(['--help'])
	assert.equal(help.status, 0)
	for(const c of ['init', 'validate', 'dev']) {
		assert.ok(help.stdout.includes(`create-chatdaddy-app ${c}`))
	}

	assert.equal(run([]).status, 2)
	assert.equal(run(['frobnicate']).status, 2)
	assert.equal(run(['dev', '--port', 'abc']).status, 2)
	assert.equal(run(['dev', '--nope']).status, 2)
	assert.equal(run(['--version']).stdout.trim(), JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version)
})

test('package: bin entry exists and is executable, and there are no dependencies', () => {
	const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
	assert.equal(pkg.bin['create-chatdaddy-app'], 'bin/create-chatdaddy-app.mjs')
	assert.ok(readFileSync(join(PKG, pkg.bin['create-chatdaddy-app']), 'utf8').startsWith('#!/usr/bin/env node'))
	for(const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
		assert.equal(pkg[key], undefined, key)
	}
})

test('sync-scopes parsers: appGrantable subset, sorted, EventName block', () => {
	const scopes = parseScopes({ B: { appGrantable: true }, A: {}, C: { appGrantable: false }, D: { appGrantable: true } })
	assert.deepEqual(scopes, { known: ['A', 'B', 'C', 'D'], appGrantable: ['B', 'D'] })
	const ts = `export const X = { a: 'no' } as const;\nexport const EventName = {\n    ContactInsert: 'contact-insert',\n    ChatUpdate: 'chat-update'\n} as const;\n`
	assert.deepEqual(parseEventNames(ts), ['chat-update', 'contact-insert'])
	assert.throws(() => parseEventNames('nothing here'), /not found/)
	assert.throws(() => parseEventNames('export const EventName = {} as const'), /empty/)
})

test('the committed snapshots are what the parsers produce from their own shape', () => {
	const scopes = JSON.parse(readFileSync(join(PKG, 'src/data/scopes.json'), 'utf8'))
	assert.deepEqual(scopes.known, [...scopes.known].sort())
	assert.ok(scopes.appGrantable.every(s => scopes.known.includes(s)))
	const events = JSON.parse(readFileSync(join(PKG, 'src/data/events.json'), 'utf8'))
	assert.deepEqual(events.events, [...events.events].sort())
	assert.ok(scopes.source.startsWith('chatdaddy/typescript-client@'))
})

test('no source file is over 500 lines', () => {
	const r = spawnSync('sh', ['-c', 'find . -name "*.mjs" -not -path "./node_modules/*" -exec wc -l {} +'], { cwd: PKG, encoding: 'utf8' })
	const over = r.stdout.trim().split('\n').filter(l => !/ total$/.test(l)).map(l => l.trim().split(/\s+/)).filter(([n]) => Number(n) > 500)
	assert.deepEqual(over, [])
})
