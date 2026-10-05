import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { invalidManifestFixtures, validConnectionVariants, validFullManifest, validMinimalManifest } from './fixtures.mjs'
import {
	headerNameProblem, isPrivateOrLoopbackHost, isPublicSuffix, isValidHostLabel, publicSuffixSection, PUBLIC_SUFFIX_SOURCE, TENANT_SUFFIX_ALLOWLIST, unsupportedKeywords, validate, validateManifest, KEYWORDS,
} from '../src/validate/index.mjs'
import { PUBLIC_SUFFIX_ICANN_RULES, PUBLIC_SUFFIX_PRIVATE_RULES } from '../src/validate/public-suffix.mjs'

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

test('all 23 ported invalid fixtures and the 41 connection fixtures are present, and their valid base passes', () => {
	// counts pinned on purpose: dropping a fixture must be a visible edit
	assert.equal(validateManifest(validFullManifest).valid, true)
	assert.equal(invalidManifestFixtures.length, 23 + 41)
	assert.equal(validConnectionVariants.length, 4)
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
		'connection hosts must not be empty': { ...full, connections: [{ ...full.connections[1], hosts: [] }] },
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

// ---- connections ----

for(const v of validConnectionVariants) {
	test(`accepts: ${v.name}`, () => {
		const r = validateManifest({ ...validMinimalManifest, connections: [v.connection] })
		assert.deepEqual(r.errors, [])
		assert.equal(r.valid, true)
	})
}

test('header denylist: refused as headerName and as a forwarded header, case-insensitively', () => {
	for(const name of [
		'Host', 'host', 'COOKIE', 'Proxy-Authorization', 'proxy-foo', 'Connection', 'Transfer-Encoding', 'Content-Length',
		'TE', 'Upgrade', 'X-Forwarded-For', 'x-forwarded-host', 'X-Real-IP',
		'Forwarded', 'Via', 'Set-Cookie', 'Keep-Alive', 'Expect', 'X-Original-URL', 'X-Rewrite-URL',
		'X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override',
	]) {
		assert.ok(headerNameProblem(name, { allowAuthorization: true }), name)
		assert.ok(headerNameProblem(name, { allowAuthorization: false }), name)
	}
})

test('authorization is allowed only as the credential headerName', () => {
	assert.equal(headerNameProblem('Authorization', { allowAuthorization: true }), undefined)
	assert.ok(headerNameProblem('AUTHORIZATION', { allowAuthorization: false }))
})

test('header names: token characters pass, anything else is refused', () => {
	for(const name of ['X-Shopify-Access-Token', 'x-api-key', 'Accept-Language', 'Idempotency-Key', "X-A_b.c~d!#$%&'*+^`|"]) {
		assert.equal(headerNameProblem(name, { allowAuthorization: false }), undefined, name)
	}

	for(const name of ['', 'X A', 'X:A', 'X\r\nA', 'X\nA', 'X\0A', 'caf\u00e9', 'X(A)', 'X/A', 'X\tA']) {
		assert.match(headerNameProblem(name, { allowAuthorization: true }), /not a valid header name/, JSON.stringify(name))
	}
})

test('a headerPrefix is printable ASCII only (space allowed; no tab, CR, LF, NUL, DEL or non-ASCII)', () => {
	const check = headerPrefix => validateManifest({ ...validMinimalManifest, connections: [{ ...validConnectionVariants[0].connection, headerPrefix }] })
	assert.equal(check('Bearer ').valid, true)
	assert.equal(check('Token ~!').valid, true)
	for(const bad of ['a\rb', 'a\nb', 'a\0b', 'Token\t', 'a\x7fb', 'caf\u00e9']) {
		assert.equal(check(bad).valid, false, JSON.stringify(bad))
	}
})

test('a template suffix gets the private-host rules too', () => {
	const apiKey = validFullManifest.connections[1]
	const check = host => validateManifest({ ...validMinimalManifest, connections: [{ ...apiKey, hosts: [host] }] })
	assert.equal(check('{tenant}.acme-cloud.com').valid, true)
	const privateErrors = host => check(host).errors.filter(e => e.message.includes('private/loopback'))
	// exactly one: the template is checked by its suffix, not also as an exact host
	assert.equal(privateErrors('{tenant}.printer.local').length, 1)
	assert.equal(privateErrors('{tenant}.10.0.0.1').length, 1)
})

const suffixCheck = host => validateManifest({ ...validMinimalManifest, connections: [{ ...validFullManifest.connections[1], hosts: [host] }] })
const suffixRefused = host => suffixCheck(host).errors.some(e => e.message.includes('must not be a public suffix'))

test('host template: {x}.myshopify.com is accepted (private section, allowlisted)', () => {
	assert.deepEqual(suffixCheck('{tenant}.myshopify.com').errors, [])
	assert.equal(suffixCheck('{tenant}.myshopify.com').valid, true)
})

test('host template: private-section suffixes that are not allowlisted are refused', () => {
	for(const suffix of ['github.io', 'herokuapp.com', 'vercel.app', 'workers.dev']) {
		assert.equal(suffixRefused(`{tenant}.${suffix}`), true, suffix)
	}
})

const hasMessage = (host, text) => suffixCheck(host).errors.some(e => e.message.includes(text))

test('host template: ICANN-section suffixes are refused with the public-suffix message (wildcard rules included)', () => {
	for(const suffix of ['co.uk', 'gov.uk', 'foo.ck', 'com.au']) {
		assert.equal(suffixRefused(`{tenant}.${suffix}`), true, suffix)
	}
})

test('host template: a single-label suffix is refused for having fewer than two labels', () => {
	for(const suffix of ['com', 'unlisted-tld', 'io', '1']) {
		assert.equal(hasMessage(`{tenant}.${suffix}`, 'at least two labels'), true, suffix)
	}
})

test('host template: a numeric last label is refused (it turns the host into an IPv4 address)', () => {
	// `{s}.168.1` filled with 192 is https://192.168.1, which the URL parser reads as 192.168.0.1
	assert.equal(new URL('https://192.168.1').hostname, '192.168.0.1')
	for(const suffix of ['168.1', '1.1', '0x7f.1', '10.0.0.1', 'acme.123']) {
		assert.equal(hasMessage(`{tenant}.${suffix}`, 'must not end in a numeric label'), true, suffix)
	}
})

test('host template: the suffix must equal its own URL normalisation', () => {
	for(const suffix of ['acme.0x7f', 'xn--a.com', 'acme.0x']) {
		assert.equal(hasMessage(`{tenant}.${suffix}`, 'own URL normalisation'), true, suffix)
	}
})

const exactMessages = host => validateManifest({ ...validMinimalManifest, connections: [{ ...validFullManifest.connections[1], hosts: [host] }] })
	.errors.filter(e => e.path === '/connections/0/hosts/0').map(e => e.message)

test('exact hosts: anything that is not its own URL normalisation is refused', () => {
	for(const host of ['a.com:8443', 'u@evil.com', 'evil.com/x', 'a.com?x', 'a.com#f', 'A.com', 'a%41.com']) {
		assert.ok(exactMessages(host).some(m => m.includes('URL normalisation')), host)
	}
})

test('exact hosts: wildcards, trailing dots, empty labels and odd characters are refused', () => {
	for(const host of ['*.a.com', 'a.com.', 'a..com', '.a.com', 'a_b.com', '-a.com', 'a-.com']) {
		assert.ok(exactMessages(host).some(m => m.includes('lower-case labels')), host)
	}
})

test('exact hosts: IP literals in every form are refused', () => {
	for(const host of ['127.0.0.1', '8.8.8.8', '[::1]', '[2606:4700::1111]', '2130706433', '0x7f000001', '127.1', '1.2.3']) {
		assert.ok(exactMessages(host).some(m => m.includes('IP address')), host)
	}
})

test('exact hosts: bare lower-case hostnames are accepted', () => {
	for(const host of ['a.com', 'api.acme.com', 'xn--bcher-kva.example', 'a1.b-2.example.org', 'x.1e3']) {
		assert.deepEqual(exactMessages(host), [], host)
	}
})

test('the oauth2 tie still compares the endpoint hosts in normalised form', () => {
	const oauth = validFullManifest.connections[0]
	const r = validateManifest({ ...validMinimalManifest, connections: [{ ...oauth, authUrl: 'https://SHOPIFY.com./a', hosts: ['shopify.com', 'api.shopify.com'] }] })
	assert.deepEqual(r.errors, [])
})

test('the tenant allowlist is exactly myshopify.com, and every entry is a private-section suffix', () => {
	assert.deepEqual([...TENANT_SUFFIX_ALLOWLIST], ['myshopify.com'])
	for(const suffix of TENANT_SUFFIX_ALLOWLIST) {
		assert.equal(publicSuffixSection(suffix), 'private')
	}
})

test('exact hosts are left alone: neither the list nor the allowlist applies to them', () => {
	for(const host of ['myshopify.com', 'shop.myshopify.com', 'github.io', 'api.github.io']) {
		assert.equal(suffixCheck(host).valid, true, host)
	}
})

test('isValidHostLabel accepts plain lower-case labels', () => {
	for(const label of ['a', 'shop', 'my-shop', 'a1', '1a', '0', 'a-b-c', 'x'.repeat(63), 'shop2024']) {
		assert.equal(isValidHostLabel(label), true, label)
	}
})

test('isValidHostLabel rejects everything else', () => {
	for(const [name, label] of [
		['upper case', 'Shop'], ['empty', ''], ['leading hyphen', '-shop'], ['trailing hyphen', 'shop-'],
		['doubled hyphen', 'my--shop'], ['xn-- prefix', 'xn--bcher-kva'], ['dot', 'a.b'], ['trailing dot', 'shop.'],
		['non-ASCII', 'caf\u00e9'], ['non-ASCII digit', '\u0663'], ['space', 'my shop'], ['slash', 'a/b'],
		['underscore', 'my_shop'], ['64 characters', 'x'.repeat(64)], ['only a hyphen', '-'],
		['newline at the end', 'shop\n'], ['at sign', 'a@b'], ['wildcard', '*'], ['brace', '{a}'],
	]) {
		assert.equal(isValidHostLabel(label), false, name)
	}

	for(const v of [undefined, null, 5, {}, ['a']]) {
		assert.equal(isValidHostLabel(v), false)
	}
})

test('isPublicSuffix: listed suffixes (ICANN, private, wildcard, IDN, unlisted TLD)', () => {
	for(const d of [
		'com', 'uk', 'co.uk', 'github.io', 'herokuapp.com', 'vercel.app', 'workers.dev', 'myshopify.com',
		's3.amazonaws.com', 'foo.ck', 'xn--55qx5d.cn', 'unlisted-tld',
	]) {
		assert.equal(isPublicSuffix(d), true, d)
	}
})

test('isPublicSuffix: registrable domains and the *.ck exception are not suffixes', () => {
	for(const d of ['example.com', 'acme-cloud.com', 'example.co.uk', 'foo.github.io', 'www.ck', 'a.foo.ck', 'acme.com']) {
		assert.equal(isPublicSuffix(d), false, d)
	}
})

test('the public suffix snapshot has the private section and a recorded source', () => {
	assert.ok(PUBLIC_SUFFIX_ICANN_RULES.length > 5000)
	assert.ok(PUBLIC_SUFFIX_PRIVATE_RULES.length > 1000)
	assert.equal(PUBLIC_SUFFIX_SOURCE.url, 'https://publicsuffix.org/list/public_suffix_list.dat')
	assert.match(PUBLIC_SUFFIX_SOURCE.version, /^\d{4}-\d{2}-\d{2}_/)
	for(const rule of ['com', 'co.uk', '*.ck', '!www.ck']) {
		assert.ok(PUBLIC_SUFFIX_ICANN_RULES.includes(rule), rule)
	}

	for(const rule of ['github.io', 'vercel.app', 'myshopify.com']) {
		assert.ok(PUBLIC_SUFFIX_PRIVATE_RULES.includes(rule), rule)
		assert.ok(!PUBLIC_SUFFIX_ICANN_RULES.includes(rule), rule)
	}
})

test('publicSuffixSection tells ICANN, private and neither apart', () => {
	for(const [domain, section] of [
		['com', 'icann'], ['co.uk', 'icann'], ['foo.ck', 'icann'], ['unlisted-tld', 'icann'], ['xn--55qx5d.cn', 'icann'],
		['github.io', 'private'], ['herokuapp.com', 'private'], ['myshopify.com', 'private'], ['s3.amazonaws.com', 'private'],
		['example.com', undefined], ['foo.github.io', undefined], ['www.ck', undefined],
	]) {
		assert.equal(publicSuffixSection(domain), section, domain)
	}
})

test('engine: maxItems', () => {
	assert.deepEqual(errs({ maxItems: 2 }, [1, 2]), [])
	assert.deepEqual(errs({ maxItems: 2 }, [1, 2, 3]), ['(root) must NOT have more than 2 items'])
	assert.deepEqual(errs({ maxItems: 2 }, 'abc'), [])
})
