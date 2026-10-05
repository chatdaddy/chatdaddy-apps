import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isValidEventId, verifyAppToBots } from '../src/signing.mjs'
import { sendTrigger } from '../src/trigger.mjs'

test('sendTrigger posts a body signed app-to-bots, bound to the event id', async() => {
	let seen
	const fakeFetch = async(url, init) => {
		seen = { url, init }
		return new Response('{"fired":1}', { status: 202 })
	}

	const res = await sendTrigger({
		botsUrl: 'https://bots.example.test/', installationId: 'inst-1', triggerId: 'example-event',
		payload: { message: 'hi' }, secret: 'whsec_s', eventId: 'order-1', fetch: fakeFetch, now: 1700000000,
	})
	assert.equal(res.ok, true)
	assert.equal(seen.url, 'https://bots.example.test/apps/triggers/inst-1/example-event')
	assert.equal(seen.init.headers['x-chatdaddy-event-id'], 'order-1')
	assert.equal(seen.init.body, '{"message":"hi"}')
	assert.equal(verifyAppToBots('whsec_s', 'order-1', seen.init.body, seen.init.headers['x-chatdaddy-signature'], 1700000000), true)
	assert.equal(verifyAppToBots('whsec_s', 'order-2', seen.init.body, seen.init.headers['x-chatdaddy-signature'], 1700000000), false)
})

test('sendTrigger refuses a bad event id and an oversized payload', async() => {
	const base = { botsUrl: 'https://b.test', installationId: 'i', triggerId: 't', secret: 's', fetch: async() => new Response('') }
	await assert.rejects(sendTrigger({ ...base, payload: {}, eventId: 'a.b' }), /invalid event id/)
	await assert.rejects(sendTrigger({ ...base, payload: { x: 'y'.repeat(70000) } }), /over/)
})

test('the default event id is valid and different each time', async() => {
	const ids = new Set()
	for(let i = 0; i < 3; i++) {
		const r = await sendTrigger({ botsUrl: 'https://b.test', installationId: 'i', triggerId: 't', payload: {}, secret: 's', fetch: async() => new Response('') })
		assert.equal(isValidEventId(r.eventId), true)
		ids.add(r.eventId)
	}

	assert.equal(ids.size, 3)
})
