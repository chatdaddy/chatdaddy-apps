import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizePhone as n } from '../src/phone.mjs'

test('already international numbers, however punctuated', () => {
	assert.equal(n('+1 (555) 123-4567'), '+15551234567')
	assert.equal(n('+852 9123 4567'), '+85291234567')
	assert.equal(n('tel:+852-9123-4567'), '+85291234567')
	assert.equal(n('0085291234567'), '+85291234567') // 00 international prefix
	assert.equal(n(447700900123, 'GB'), '+447700900123') // a number, not a string
})

test('national numbers use the country hint, and drop the trunk zero', () => {
	assert.equal(n('91234567', 'HK'), '+85291234567')
	assert.equal(n('0912 345 678', 'PH'), '+63912345678')
	assert.equal(n('012-3456789', 'MY'), '+60123456789')
	assert.equal(n('07700 900123', 'gb'), '+447700900123')
	assert.equal(n('(555) 123-4567', 'US'), '+15551234567')
})

test('a number that already carries its country code is not prefixed twice', () => {
	assert.equal(n('85291234567', 'HK'), '+85291234567')
	assert.equal(n('15551234567', 'US'), '+15551234567')
	assert.equal(n('60123456789', 'MY'), '+60123456789')
})

test('trunk zero in brackets and extensions', () => {
	assert.equal(n('+60 (0)12-345 6789'), '+60123456789')
	assert.equal(n('+852 9123 4567 ext. 12'), '+85291234567')
	assert.equal(n('+852 9123 4567 x12'), '+85291234567')
})

test('unusable input is undefined, never a guess', () => {
	for(const bad of [undefined, null, '', '   ', 'abc', 'N/A', '123', '+123', '+0123456789', '1'.repeat(16), {}, '91234567']) {
		assert.equal(n(bad), undefined, `${JSON.stringify(bad)}`)
	}

	assert.equal(n('91234567', 'ZZ'), undefined) // unknown country, no "+"
})
