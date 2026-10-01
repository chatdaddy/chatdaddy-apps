import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CHATDADDY_PUBLIC_KEY } from '../src/jwt.mjs'
import { createKeyResolver } from '../src/keys.mjs'

test('no dev key configured: ChatDaddy\'s real public key, in every environment', () => {
	assert.equal(createKeyResolver({})(), CHATDADDY_PUBLIC_KEY)
	assert.equal(createKeyResolver({ NODE_ENV: 'production' })(), CHATDADDY_PUBLIC_KEY)
})

test('dev key outside production is trusted', () => {
	assert.equal(createKeyResolver({ CHATDADDY_DEV_PUBLIC_KEY: 'DEV-PEM' })(), 'DEV-PEM')
	assert.equal(createKeyResolver({ CHATDADDY_DEV_PUBLIC_KEY: 'DEV-PEM', NODE_ENV: 'development' })(), 'DEV-PEM')
})

test('dev key file is re-read on every call', () => {
	const file = join(mkdtempSync(join(tmpdir(), 'cd-key-')), 'k.pem')
	writeFileSync(file, 'ONE')
	const get = createKeyResolver({ CHATDADDY_DEV_PUBLIC_KEY_FILE: file })
	assert.equal(get(), 'ONE')
	writeFileSync(file, 'TWO')
	assert.equal(get(), 'TWO')
})

test('dev key under NODE_ENV=production is refused, in either form', () => {
	assert.throws(() => createKeyResolver({ CHATDADDY_DEV_PUBLIC_KEY: 'DEV-PEM', NODE_ENV: 'production' }), /Refusing to start/)
	assert.throws(() => createKeyResolver({ CHATDADDY_DEV_PUBLIC_KEY_FILE: '/x', NODE_ENV: 'production' }), /Refusing to start/)
})

test('setting both dev key forms is an error', () => {
	assert.throws(() => createKeyResolver({ CHATDADDY_DEV_PUBLIC_KEY: 'a', CHATDADDY_DEV_PUBLIC_KEY_FILE: 'b' }), /only one/)
})
