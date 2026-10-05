import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { invalidManifestFixtures, validFullManifest, validMinimalManifest } from './fixtures.mjs'
import { isPrivateOrLoopbackHost, unsupportedKeywords, validate, validateManifest, KEYWORDS } from '../src/validate/index.mjs'

const data = name => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url), 'utf8'))

test('accepts the minimal valid manifest', () => {
	const r = validateManifest(validMinimalManifest)
	assert.deepEqual(r.errors, [])
	assert.equal(r.valid, true)
})

test('accepts the full valid manifest', () => {
	const r = validateManifest(validFullManifest)
	assert.deepEqual(r.errors, [])
	assert.equal(r.valid, true)
})

test('rejects a manifest that is not an object', () => {
	for(const v of [null, 'nope', 42, undefined]) {
		assert.equal(validateManifest(v).valid, false)
	}
})

test('does not crash on malformed shapes inside the semantic layer', () => {
	for(const bad of [{ connections: 'x' }, { connections: [null, 3] }, { flowActions: [null] }, { settings: [1] }, { scopes: [1, null] }]) {
		assert.equal(validateManifest({ ...validMinimalManifest, ...bad }).valid, false)
	}
})

for(const f of invalidManifestFixtures) {
	test(`rejects: ${f.rule}`, () => {
		const r = validateManifest(f.manifest)
		assert.equal(r.valid, false)
		assert.ok(r.errors.length > 0)
		assert.ok(
			r.errors.some(e => e.path.includes(f.expect) || e.message.includes(f.expect)),
			`no error mentions "${f.expect}": ${JSON.stringify(r.errors)}`
		)
	})
}

test('all 23 ported invalid fixtures are present, and their valid base passes', () => {
	assert.equal(validateManifest(validFullManifest).valid, true)
	assert.equal(invalidManifestFixtures.length, 23)
})

test('ids must be hyphen-separated lower-case slugs', () => {
	for(const id of ['a--b', '-a', 'a-', 'A', 'a_b', 'a b', '', 'x'.repeat(65)]) {
		assert.equal(validateManifest({ ...validMinimalManifest, id }).valid, false, JSON.stringify(id))
	}

	for(const id of ['a', 'a-b', 'a1-2b', 'x'.repeat(64)]) {
		assert.equal(validateManifest({ ...validMinimalManifest, id }).valid, true, id)
	}
})

test('schema rules the ported fixtures do not reach', () => {
	const full = validFullManifest
	const withSetting = s => ({ ...full, settings: [s] })
	const cases = {
		'connection hosts must not be empty': { ...full, connections: [{ ...full.connections[0], hosts: [] }] },
		'connection type must be oauth2|apiKey': { ...full, connections: [{ ...full.connections[0], type: 'basic' }] },
		'a scope may not be an empty string': { ...full, scopes: [''] },
		'developer.email must be an email': { ...full, developer: { ...full.developer, email: 'not an email' } },
		'description over 500 characters': { ...full, description: 'x'.repeat(501) },
		'name over 128 characters': { ...full, name: 'x'.repeat(129) },
		'property type must be string|number|boolean|array': withSetting({ propertyPath: 'a', title: 'A', type: 'object' }),
		'option label over 64 characters': withSetting({ propertyPath: 'a', title: 'A', type: 'string', options: [{ label: 'x'.repeat(65), valueStr: 'v' }] }),
		'option needs valueStr': withSetting({ propertyPath: 'a', title: 'A', type: 'string', options: [{ label: 'l' }] }),
		'array items type must be known': withSetting({ propertyPath: 'a', title: 'A', type: 'array', items: { type: 'map' } }),
		'property description over 200 characters': withSetting({ propertyPath: 'a', title: 'A', type: 'string', description: 'x'.repeat(201) }),
		'property has no unknown keys': withSetting({ propertyPath: 'a', title: 'A', type: 'string', icon: 'x' }),
		'template needs a name': { ...full, templates: [{ id: 'a' }] },
		'trigger payloadSchema must be an object': { ...full, flowTriggers: [{ ...full.flowTriggers[0], payloadSchema: 'x' }] },
		'trigger needs a payloadSchema': { ...full, flowTriggers: [{ id: 'a', title: 'A' }] },
		'action needs outputProperties': { ...full, flowActions: [{ id: 'a', title: 'A', inputProperties: [] }] },
		'connection id must be a slug': { ...full, connections: [{ ...full.connections[0], id: 'Not Slug' }] },
		'eventSubscriptions entries are strings': { ...full, eventSubscriptions: [1] },
		'handler may not mix hosted and baseUrl': { ...full, handler: { type: 'hosted', baseUrl: 'https://example.com' } },
		'handler type must be hosted|url': { ...full, handler: { type: 'other' } },
		'developer is required': { ...full, developer: undefined },
		'privacyPolicyUrl over 2048 characters': { ...full, privacyPolicyUrl: `https://example.com/${'a'.repeat(2040)}` },
	}
	for(const [name, manifest] of Object.entries(cases)) {
		assert.equal(validateManifest(manifest).valid, false, name)
	}
})

test('semantic and schema errors are reported together, not one layer at a time', () => {
	const r = validateManifest({ ...validFullManifest, aiUse: 'x', scopes: ['NOT_A_REAL_SCOPE'], handler: { type: 'url', baseUrl: 'https://localhost' } })
	const has = text => r.errors.some(e => e.message.includes(text))
	assert.ok(has('aiUse'))
	assert.ok(has('unknown scope'))
	assert.ok(has('private/loopback'))
})

test('developer.url and every connection URL are host-checked', () => {
	const full = validFullManifest
	for(const manifest of [
		{ ...full, developer: { ...full.developer, url: 'https://10.1.2.3/x' } },
		{ ...full, connections: [{ ...full.connections[0], tokenUrl: 'https://[::1]/t' }] },
		{ ...full, privacyPolicyUrl: 'https://printer.local/privacy' },
	]) {
		const r = validateManifest(manifest)
		assert.equal(r.valid, false)
		assert.ok(r.errors.some(e => e.message.includes('private/loopback')), JSON.stringify(r.errors))
	}
})

test('duplicate outputProperties paths within an action are refused', () => {
	const act = validFullManifest.flowActions[0]
	const r = validateManifest({ ...validFullManifest, flowActions: [{ ...act, outputProperties: [act.outputProperties[0], act.outputProperties[0]] }] })
	assert.ok(r.errors.some(e => e.message.includes('duplicate outputProperties propertyPath')))
})

test('does not mutate the input manifest', () => {
	const before = JSON.stringify(validFullManifest)
	validateManifest(validFullManifest)
	assert.equal(JSON.stringify(validFullManifest), before)
})

test('ported host cases: private/loopback', () => {
	for(const h of [
		'https://localhost./x', 'localhost.', 'https://LOCALHOST../x',
		'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[::ffff:10.0.0.5]/',
		'https://[::ffff:a9fe:a9fe]/', 'https://[::127.0.0.1]/', 'https://[::1]/', 'https://127.1/',
		'https://2130706433/', 'https://0x7f000001/', 'https://10.0.0.1./',
		'https://app.local/', 'https://x.localhost/', 'https://0.1.2.3/', 'https://192.168.0.9/', 'https://10.255.0.1/', 'https://127.0.0.2/', 'https://172.16.0.1/', 'https://172.31.255.1/', 'https://169.254.1.1/',
		'https://[fe80::1]/', 'https://[fd00::1]/', 'https://0.0.0.0/',
	]) {
		assert.equal(isPrivateOrLoopbackHost(h), true, h)
	}
})

test('ported host cases: public', () => {
	for(const h of [
		'https://example.com/', 'example.com.', 'https://[::ffff:8.8.8.8]/', 'https://[2606:4700::1111]/', 'https://8.8.8.8/',
		'https://172.15.0.1/', 'https://172.32.0.1/', 'https://192.169.0.1/',
	]) {
		assert.equal(isPrivateOrLoopbackHost(h), false, h)
	}
})

const NON_GRANTABLE = [
	'ADMIN_PANEL_ACCESS', 'PARTNER_ADMIN_PANEL_ACCESS', 'TEAM_UPDATE', 'TEAMMEMBERS_UPDATE',
	'CHATDADDY_HOOK', 'INTEGRATIONS_UPDATE', 'ACCOUNT_DELETE', 'CONTACTS_DELETE', 'APPS_DEVELOP',
]

test('the non-grantable list only names scopes that exist in the snapshot (a removed scope fails loudly)', () => {
	const { known } = data('scopes')
	assert.deepEqual(NON_GRANTABLE.filter(s => !known.includes(s)), [])
})

test('non-grantable scopes are refused with "cannot be granted to an app"', () => {
	for(const scope of NON_GRANTABLE) {
		const r = validateManifest({ ...validMinimalManifest, scopes: [scope] })
		assert.equal(r.valid, false, scope)
		assert.ok(r.errors.some(e => e.message.includes('cannot be granted to an app')), scope)
		assert.ok(!r.errors.some(e => e.message.includes('unknown scope')), scope)
	}
})

test('every appGrantable scope is accepted, and there are some', () => {
	const { appGrantable, known } = data('scopes')
	assert.ok(appGrantable.length > 0)
	assert.ok(appGrantable.every(s => known.includes(s)))
	assert.ok(appGrantable.length < known.length)
	const r = validateManifest({ ...validMinimalManifest, scopes: appGrantable })
	assert.deepEqual(r.errors.filter(e => e.path === '/scopes'), [])
})

test('every event name in the snapshot is accepted; a made-up one is not', () => {
	const { events } = data('events')
	assert.ok(events.includes('contact-insert'))
	assert.equal(validateManifest({ ...validMinimalManifest, eventSubscriptions: events }).valid, true)
	assert.equal(validateManifest({ ...validMinimalManifest, eventSubscriptions: ['contact-insert', 'contact-insert'] }).valid, false)
})

// ---- the engine, keyword by keyword (the fixtures do not reach every keyword) ----

const errs = (schema, v) => validate(schema, v).map(e => e.message)

test('engine: type', () => {
	assert.deepEqual(errs({ type: 'string' }, 'a'), [])
	assert.deepEqual(errs({ type: 'string' }, 1), ['(root) must be string'])
	assert.deepEqual(errs({ type: 'number' }, NaN), ['(root) must be number'])
	assert.deepEqual(errs({ type: 'object' }, []), ['(root) must be object'])
	assert.deepEqual(errs({ type: 'object' }, null), ['(root) must be object'])
	assert.deepEqual(errs({ type: 'array' }, {}), ['(root) must be array'])
	assert.deepEqual(errs({ type: 'boolean' }, 'true'), ['(root) must be boolean'])
})

test('engine: length keywords count code points, apply to strings only', () => {
	assert.deepEqual(errs({ maxLength: 1 }, '\u{1F600}'), [])
	assert.deepEqual(errs({ maxLength: 1 }, 'ab'), ['(root) must NOT have more than 1 characters'])
	assert.deepEqual(errs({ minLength: 1 }, ''), ['(root) must NOT have fewer than 1 characters'])
	assert.deepEqual(errs({ minLength: 1 }, 5), [])
})

test('engine: const and enum compare deeply', () => {
	assert.equal(errs({ const: [1, 2] }, [1, 2]).length, 0)
	assert.equal(errs({ const: [1, 2] }, [1, 3]).length, 1)
	assert.equal(errs({ const: [1, 2] }, [1]).length, 1)
	assert.equal(errs({ const: { a: 1 } }, { a: 1 }).length, 0)
	assert.equal(errs({ const: { a: 1 } }, { a: 2 }).length, 1)
	assert.equal(errs({ const: { a: 1 } }, { b: 1 }).length, 1)
	assert.equal(errs({ const: { a: 1 } }, { a: 1, b: 2 }).length, 1)
	assert.equal(errs({ enum: [[1], { a: [2] }] }, { a: [2] }).length, 0)
	assert.equal(errs({ enum: [[1], { a: [2] }] }, { a: [3] }).length, 1)
})

test('engine: pattern, enum, const, minItems, format', () => {
	assert.deepEqual(errs({ pattern: '^a' }, 'ba').length, 1)
	assert.deepEqual(errs({ enum: ['a', 'b'] }, 'c'), ['(root) must be equal to one of the allowed values'])
	assert.deepEqual(errs({ enum: [{ a: 1 }] }, { a: 1 }), [])
	assert.deepEqual(errs({ const: 1 }, '1'), ['(root) must be equal to constant'])
	assert.deepEqual(errs({ minItems: 2 }, [1]), ['(root) must NOT have fewer than 2 items'])
	assert.equal(errs({ format: 'email' }, 'not-an-email').length, 1)
	assert.equal(errs({ format: 'email' }, 'a@example.com').length, 0)
	assert.equal(errs({ format: 'uri' }, 'no scheme').length, 1)
	assert.equal(errs({ format: 'uri' }, 'https://example.com/a?b=c').length, 0)
	assert.equal(errs({ format: 'email' }, 5).length, 0)
})

test('engine: required / properties / additionalProperties / items with paths', () => {
	const schema = {
		type: 'object', required: ['a'], additionalProperties: false,
		properties: { a: { type: 'string' }, l: { type: 'array', items: { type: 'number' } } },
	}
	assert.deepEqual(validate(schema, { a: 'x', l: [1, 2] }), [])
	assert.deepEqual(validate(schema, {}).map(e => e.message), ["(root) must have required property 'a'"])
	assert.equal(validate(schema, { a: 'x', z: 1 }).length, 1)
	assert.deepEqual(validate(schema, { a: 1, l: [1, 'x'] }).map(e => e.path), ['/a', '/l/1'])
	assert.deepEqual(validate({ properties: { 'a/b': { type: 'string' } } }, { 'a/b': 1 }).map(e => e.path), ['/a~1b'])
	assert.deepEqual(validate({ additionalProperties: { type: 'number' } }, { x: 'no' }).map(e => e.path), ['/x'])
})

test('engine: oneOf needs exactly one; allOf needs all; if/then', () => {
	const one = { oneOf: [{ type: 'string' }, { type: 'number' }] }
	assert.deepEqual(errs(one, 'a'), [])
	assert.ok(errs(one, true).some(m => m.includes('exactly one schema in oneOf')))
	assert.ok(errs({ oneOf: [{ type: 'string' }, { minLength: 1 }] }, 'a').some(m => m.includes('exactly one')))
	assert.equal(errs({ allOf: [{ type: 'string' }, { minLength: 3 }] }, 'ab').length, 1)
	const cond = { if: { properties: { k: { const: 'x' } } }, then: { required: ['v'] } }
	assert.deepEqual(errs(cond, { k: 'y' }), [])
	assert.deepEqual(errs(cond, { k: 'x', v: 1 }), [])
	assert.equal(errs(cond, { k: 'x' }).length, 2)
})

test('engine: $ref resolves locally; others throw', () => {
	const s = { definitions: { d: { type: 'string' } }, properties: { a: { $ref: '#/definitions/d' } } }
	assert.equal(validate(s, { a: 1 }).length, 1)
	assert.throws(() => validate({ $ref: 'http://x/y' }, 1), /unsupported \$ref/)
	assert.throws(() => validate({ $ref: '#/nope' }, 1), /unresolvable/)
})

test('engine: undefined counts as absent, like ajv', () => {
	assert.equal(errs({ required: ['a'] }, { a: undefined }).length, 1)
	assert.equal(errs({ properties: { a: { type: 'string' } } }, { a: undefined }).length, 0)
})

test('unsupportedKeywords lists what the engine would silently skip', () => {
	assert.deepEqual(unsupportedKeywords({ type: 'object', properties: { a: { type: 'number', minimum: 1 } } }), ['/properties/a: minimum'])
	assert.deepEqual(unsupportedKeywords({ type: 'string', title: 't' }), [])
	assert.deepEqual(unsupportedKeywords({ items: [{ type: 'string' }] }), ['/: items (tuple form)'])
	assert.ok(KEYWORDS.includes('oneOf'))
})

test('the manifest schema uses only implemented keywords', async() => {
	const { APP_MANIFEST_SCHEMA } = await import('../src/validate/index.mjs')
	assert.deepEqual(unsupportedKeywords(APP_MANIFEST_SCHEMA), [])
})
