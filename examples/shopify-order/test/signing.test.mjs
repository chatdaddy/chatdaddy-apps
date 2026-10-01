import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	APP_SIGNATURE_TOLERANCE_S, computeHandshakeAck, signAppToBots, signBotsToApp, verifyAppToBots, verifyBotsToApp,
} from '../src/signing.mjs'

// Vectors computed by running chatdaddy-service-bots/src/utils/app-signing.ts itself:
//   node --experimental-strip-types -e "import('./src/utils/app-signing.ts').then(m => ...)"
// with secret 'whsec_testsecret', t=1700000000, body '{"a":1}', eventId 'evt-1', nonce 'nonce123'.
const S = 'whsec_testsecret'
const T = 1700000000
const BODY = '{"a":1}'
const V_APP_TO_BOTS = 't=1700000000,v1=4990f08a931e60cd3c4506765e07fd1502c625d7d8ee33c4c6fd400c0b3f852d'
const V_BOTS_TO_APP = 't=1700000000,v1=17712ca06d9113edf2d40f5aea05078c162169f1c16a84e537b9c0cad2c96469'
const V_ACK = 'd4ebb7faf892560818f5b1b9931cd1354e4dc804352c3e2e2736935e684a5ff5'

test('app-to-bots matches the bots vector', () => {
	assert.equal(signAppToBots(S, 'evt-1', BODY, T), V_APP_TO_BOTS)
})

test('bots-to-app matches the bots vector', () => {
	assert.equal(signBotsToApp(S, BODY, T), V_BOTS_TO_APP)
})

test('handshake ack matches the bots vector', () => {
	assert.equal(computeHandshakeAck(S, 'nonce123'), V_ACK)
})

test('the three directions produce three different MACs', () => {
	assert.notEqual(V_APP_TO_BOTS, V_BOTS_TO_APP)
	assert.notEqual(V_BOTS_TO_APP.split('v1=')[1], V_ACK)
})

test('a bots-to-app signature does not verify as app-to-bots, and vice versa', () => {
	assert.equal(verifyBotsToApp(S, BODY, V_BOTS_TO_APP, T), true)
	assert.equal(verifyBotsToApp(S, BODY, V_APP_TO_BOTS, T), false)
	assert.equal(verifyAppToBots(S, 'evt-1', BODY, V_APP_TO_BOTS, T), true)
	assert.equal(verifyAppToBots(S, 'evt-1', BODY, V_BOTS_TO_APP, T), false)
})

test('app-to-bots is bound to the event id', () => {
	assert.equal(verifyAppToBots(S, 'evt-2', BODY, V_APP_TO_BOTS, T), false)
})

test("event ids containing '.' or outside printable ASCII are refused", () => {
	assert.throws(() => signAppToBots(S, 'a.b', BODY, T), /invalid event id/)
	assert.throws(() => signAppToBots(S, '', BODY, T), /invalid event id/)
	assert.throws(() => signAppToBots(S, 'a b', BODY, T), /invalid event id/)
	assert.throws(() => signAppToBots(S, 'x'.repeat(129), BODY, T), /invalid event id/)
	assert.doesNotThrow(() => signAppToBots(S, 'x'.repeat(128), BODY, T))
})

test('tolerance is 300s either side', () => {
	assert.equal(APP_SIGNATURE_TOLERANCE_S, 300)
	assert.equal(verifyBotsToApp(S, BODY, V_BOTS_TO_APP, T + 300), true)
	assert.equal(verifyBotsToApp(S, BODY, V_BOTS_TO_APP, T + 301), false)
	assert.equal(verifyBotsToApp(S, BODY, V_BOTS_TO_APP, T - 301), false)
})

test('header parsing is strict', () => {
	const v1 = V_BOTS_TO_APP.split('v1=')[1]
	for(const bad of [
		undefined, '', `t=${T}`, `t=${T},v1=${v1},x=1`, `t=${T},t=${T}`, `t=${T},v1=${v1.toUpperCase()}`,
		`t=-1,v1=${v1}`, `t=${T},v1=${v1.slice(2)}`, `v1=${v1}`,
	]) {
		assert.equal(verifyBotsToApp(S, BODY, bad, T), false, `${bad}`)
	}
})

test('previous secret verifies when passed in the list; a wrong secret does not', () => {
	assert.equal(verifyBotsToApp(['other', S], BODY, V_BOTS_TO_APP, T), true)
	assert.equal(verifyBotsToApp(['other'], BODY, V_BOTS_TO_APP, T), false)
})
