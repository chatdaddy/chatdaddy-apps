// Mutation check. A test that passes proves nothing until the mechanism it guards has
// been disabled and the test seen to fail. For each mutation: assert the pattern occurs
// exactly once in the file (assert-replace), apply it, run the whole suite, record which
// tests went red, restore the file. A mutation that leaves the suite green, or that does
// not apply, is reported and fails the script.
//
// Safety: before the first mutation the sources are copied to a backup directory and
// checked against the originals by SHA-256; after the last one the working tree is
// diffed against the backup and the script fails if any byte differs.
//
//   node scripts/mutation-check.mjs [--backup <dir>] [name-substring]
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { MUTATIONS } from './mutations.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = ['bin', 'src', 'template', 'scripts']

const { values, positionals } = parseArgs({ allowPositionals: true, options: { backup: { type: 'string' } } })

const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true })
	.flatMap(e => (e.isDirectory() ? walk(join(dir, e.name), base) : [relative(base, join(dir, e.name))]))
	.sort()
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const digests = dir => Object.fromEntries(SOURCES.flatMap(s => (existsSync(join(dir, s)) ? walk(join(dir, s), dir) : [])).map(f => [f, sha(join(dir, f))]))

function suite() {
	const files = readdirSync(join(root, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => `test/${f}`)
	const env = { ...process.env }
	delete env.NODE_TEST_CONTEXT
	// a mutation that hangs the suite is killed by the outer timeout and counted
	// red (non-zero exit); the file is always restored from the backup afterwards
	const r = spawnSync(process.execPath, ['--test', '--test-timeout=60000', ...files], { cwd: root, encoding: 'utf8', env, timeout: 300_000 })
	const failed = [...r.stdout.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1]).filter(n => !/\.test\.mjs$/.test(n))
	return { code: r.status, failed: [...new Set(failed)], pass: /# pass (\d+)/.exec(r.stdout)?.[1], fail: /# fail (\d+)/.exec(r.stdout)?.[1] }
}

// ---- backup, and confirm it ----
const backup = values.backup || mkdtempSync(join(tmpdir(), 'kit-mutation-backup-'))
for(const s of SOURCES) {
	cpSync(join(root, s), join(backup, s), { recursive: true })
}

const before = digests(root)
const copied = digests(backup)
if(JSON.stringify(before) !== JSON.stringify(copied) || Object.keys(before).length === 0) {
	console.error('backup does not match the sources: aborting')
	process.exit(2)
}

console.log(`backup confirmed: ${Object.keys(before).length} files, identical by sha256, in ${backup}`)

const base = suite()
if(base.code !== 0) {
	console.error('baseline suite is not green, aborting', base)
	process.exit(2)
}

console.log(`baseline: pass=${base.pass} fail=${base.fail}`)
let bad = 0
let red = 0
const only = positionals[0]
for(const m of MUTATIONS.filter(x => !only || x.name.includes(only))) {
	const path = join(root, m.file)
	const original = readFileSync(path, 'utf8')
	const count = original.split(m.find).length - 1
	if(count !== 1) {
		console.log(`NOT APPLIED  ${m.name}: pattern found ${count} times in ${m.file}`)
		bad++
		continue
	}

	const mutated = original.replace(m.find, () => m.replace)
	if(mutated === original) {
		console.log(`NOT APPLIED  ${m.name}: no change`)
		bad++
		continue
	}

	writeFileSync(path, mutated)
	let res
	try {
		res = suite()
	} finally {
		writeFileSync(path, original)
	}

	if(readFileSync(path, 'utf8') !== original) {
		throw new Error(`restore failed for ${m.file}`)
	}

	if(res.code === 0) {
		console.log(`SURVIVED     ${m.name}`)
		bad++
	} else {
		red++
		console.log(`RED (${res.fail})  ${m.name}\n      first: ${res.failed.slice(0, 3).join(' | ')}`)
	}
}

// ---- restore check: working tree against the backup, byte for byte ----
const after = digests(root)
const drift = Object.keys({ ...before, ...after }).filter(f => before[f] !== after[f])
const final = suite()
console.log(`\n${red} red, ${bad} survived or not applied`)
console.log(`restore: ${drift.length ? `DIFFERS in ${drift.join(', ')}` : 'working tree identical to backup (sha256)'}; suite after restore: pass=${final.pass} fail=${final.fail}`)
process.exit(bad || drift.length || final.code ? 1 : 0)
