import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { BIN, cleanEnv, rmrf, tmp } from './helpers.mjs'
import { InitError, init, slugify } from '../src/init.mjs'
import { validateManifest } from '../src/validate/index.mjs'

const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
	.flatMap(e => (e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
	.sort()

test('init writes the expected tree, with the app name and id filled in', () => {
	const root = tmp()
	try {
		const r = init(join(root, 'x'), { name: 'My "Cool" App' })
		assert.equal(r.appId, 'my-cool-app')
		assert.deepEqual(walk(join(root, 'x')), [
			'.gitignore', 'README.md', 'chatdaddy-app.json', 'package.json',
			'src/actions.mjs', 'src/jwt.mjs', 'src/keys.mjs', 'src/log.mjs', 'src/main.mjs', 'src/send-trigger.mjs',
			'src/server.mjs', 'src/signing.mjs', 'src/store.mjs', 'src/trigger.mjs',
			'test/hardening.test.mjs', 'test/helpers.mjs', 'test/keys.test.mjs', 'test/server.test.mjs', 'test/signing.test.mjs', 'test/store.test.mjs', 'test/trigger.test.mjs',
		])
		assert.deepEqual(r.files, walk(join(root, 'x')))
		const manifest = JSON.parse(readFileSync(join(root, 'x', 'chatdaddy-app.json'), 'utf8'))
		assert.equal(manifest.id, 'my-cool-app')
		assert.equal(manifest.name, 'My "Cool" App')
		assert.equal(JSON.parse(readFileSync(join(root, 'x', 'package.json'), 'utf8')).name, 'my-cool-app')
		for(const f of r.files) {
			assert.ok(!readFileSync(join(root, 'x', f), 'utf8').includes('{{'), `placeholder left in ${f}`)
		}
	} finally {
		rmrf(root)
	}
})

test('the scaffolded manifest passes validate, and has the shape the ticket asks for', () => {
	const root = tmp()
	try {
		init(join(root, 'x'))
		const m = JSON.parse(readFileSync(join(root, 'x', 'chatdaddy-app.json'), 'utf8'))
		const r = validateManifest(m)
		assert.deepEqual(r.errors, [])
		assert.equal(m.flowTriggers.length, 1)
		assert.ok(m.flowTriggers[0].payloadSchema)
		assert.equal(m.flowActions.length, 1)
		assert.ok(m.flowActions[0].inputProperties.length && m.flowActions[0].outputProperties.length)
		assert.equal(m.scopes.length, 1)
		assert.equal(m.handler.type, 'url')
		assert.ok(m.handler.baseUrl.startsWith('https://'))
	} finally {
		rmrf(root)
	}
})

test('the scaffolded app\'s own tests pass (run in a temp dir)', () => {
	const root = tmp()
	try {
		init(join(root, 'x'), { name: 'Self Test App' })
		const r = spawnSync(process.execPath, ['--test', ...readdirSync(join(root, 'x', 'test')).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`)], { cwd: join(root, 'x'), encoding: 'utf8', env: cleanEnv(), timeout: 120_000 })
		assert.equal(r.status, 0, r.stdout + r.stderr)
		const count = n => Number(new RegExp(`# ${n} (\\d+)`).exec(r.stdout)?.[1])
		assert.ok(count('pass') >= 40, `only ${count('pass')} scaffold tests ran`)
		assert.equal(count('fail'), 0)
	} finally {
		rmrf(root)
	}
})

test('init refuses a non-empty directory and leaves it byte-for-byte untouched', () => {
	const root = tmp()
	try {
		const dir = join(root, 'busy')
		mkdirSync(dir)
		writeFileSync(join(dir, 'chatdaddy-app.json'), 'MINE')
		assert.throws(() => init(dir), err => err instanceof InitError && /not empty: refusing to overwrite/.test(err.message))
		assert.deepEqual(readdirSync(dir), ['chatdaddy-app.json'])
		assert.equal(readFileSync(join(dir, 'chatdaddy-app.json'), 'utf8'), 'MINE')
		// even a lone dotfile counts as non-empty
		const dot = join(root, 'dot')
		mkdirSync(dot)
		writeFileSync(join(dot, '.keep'), '')
		assert.throws(() => init(dot), InitError)
		assert.deepEqual(readdirSync(dot), ['.keep'])
	} finally {
		rmrf(root)
	}
})

test('init refuses a path that is a file; accepts an existing empty dir and a missing nested dir', () => {
	const root = tmp()
	try {
		writeFileSync(join(root, 'f'), 'x')
		assert.throws(() => init(join(root, 'f')), err => err instanceof InitError && /exists and is not a directory/.test(err.message))
		mkdirSync(join(root, 'empty'))
		assert.equal(init(join(root, 'empty')).appId, 'empty')
		assert.equal(init(join(root, 'a', 'b', 'deep-app')).appId, 'deep-app')
	} finally {
		rmrf(root)
	}
})

test('names: default from the directory, slug rules, unusable names refused', () => {
	assert.equal(slugify('My Cool App!'), 'my-cool-app')
	assert.equal(slugify('  --a__b--  '), 'a-b')
	assert.equal(slugify('x'.repeat(100)).length, 64)
	assert.equal(slugify('ab-' + 'c'.repeat(61) + '-d'), 'ab-' + 'c'.repeat(61))
	assert.equal(slugify('!!!'), '')
	const root = tmp()
	try {
		assert.throws(() => init(join(root, 'a'), { name: '!!!' }), /app name/)
		assert.throws(() => init(join(root, 'b'), { name: 'x'.repeat(129) }), /app name/)
		assert.throws(() => init(''), /usage/)
		// a JSON-hostile name still yields valid JSON and a valid manifest
		init(join(root, 'c'), { name: 'Back\\slash "quote" é' })
		const m = JSON.parse(readFileSync(join(root, 'c', 'chatdaddy-app.json'), 'utf8'))
		assert.equal(m.name, 'Back\\slash "quote" é')
		assert.deepEqual(validateManifest(m).errors, [])
	} finally {
		rmrf(root)
	}
})

test('CLI: init exits 0 and then exits 1 (not overwriting) the second time', () => {
	const root = tmp()
	try {
		const dir = join(root, 'cli-app')
		const first = spawnSync(process.execPath, [BIN, 'init', dir, '--name', 'Cli App'], { encoding: 'utf8' })
		assert.equal(first.status, 0, first.stderr)
		assert.match(first.stdout, /created Cli App \(id cli-app\)/)
		const before = readFileSync(join(dir, 'src', 'server.mjs'), 'utf8')
		writeFileSync(join(dir, 'src', 'server.mjs'), `${before}// edited\n`)
		const second = spawnSync(process.execPath, [BIN, 'init', dir], { encoding: 'utf8' })
		assert.equal(second.status, 1)
		assert.match(second.stderr, /refusing to overwrite/)
		assert.ok(readFileSync(join(dir, 'src', 'server.mjs'), 'utf8').endsWith('// edited\n'))
	} finally {
		rmrf(root)
	}
})
