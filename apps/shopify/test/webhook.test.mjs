import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { verifyAppToBots } from '../src/signing.mjs'
import { verifyShopifyHmac } from '../src/shopify.mjs'
import { CHECKOUT, DELIVERED, FULFILLMENT, ORDER } from './fixtures.mjs'
import { CLIENT_SECRET, INST_A, INST_B, SIGNING_SECRET, BOTS_URL, shopifyHmac, startApp } from './helpers.mjs'

let t
beforeEach(async() => {
	t = await startApp()
	await t.setup()
})
afterEach(() => t.close())

test('HMAC: accepts the right signature, rejects wrong secret, tampering, garbage and a missing header', () => {
	const raw = Buffer.from('{"a":1}')
	const good = shopifyHmac(CLIENT_SECRET, raw)
	assert.equal(verifyShopifyHmac(CLIENT_SECRET, raw, good), true)
	assert.equal(verifyShopifyHmac('other', raw, good), false)
	assert.equal(verifyShopifyHmac(CLIENT_SECRET, Buffer.from('{"a":2}'), good), false)
	assert.equal(verifyShopifyHmac(CLIENT_SECRET, raw, 'not-base64!!'), false)
	assert.equal(verifyShopifyHmac(CLIENT_SECRET, raw, undefined), false)
	assert.equal(verifyShopifyHmac('', raw, good), false)
})

test('webhook: bad signature, unknown installation, wrong shop domain: one bare 401, nothing sent', async() => {
	const wrongSecret = await t.webhook(INST_A, 'orders/create', ORDER, { secret: 'nope' })
	const unknown = await t.webhook(INST_B, 'orders/create', ORDER)
	const otherShop = await t.webhook(INST_A, 'orders/create', ORDER, { shop: 'someone-else.myshopify.com' })
	const notUuid = await t.webhook('not-a-uuid', 'orders/create', ORDER)
	for(const r of [wrongSecret, unknown, otherShop, notUuid]) {
		assert.equal(r.status, 401)
		assert.deepEqual(r.json, { error: 'unauthorized' })
	}

	await t.drain()
	assert.equal(t.botsCalls.length, 0)
})

test('orders/create: acknowledged, then a signed order-created trigger reaches bots', async() => {
	const r = await t.webhook(INST_A, 'orders/create', ORDER, { id: 'wh-1' })
	assert.equal(r.status, 200)
	assert.deepEqual(r.json, { accepted: true })
	await t.drain()
	assert.equal(t.botsCalls.length, 1)
	const c = t.botsCalls[0]
	assert.equal(c.url, `${BOTS_URL}/apps/triggers/${INST_A}/order-created`)
	assert.equal(c.body.orderNumber, '#1001')
	assert.equal(c.init.headers['x-chatdaddy-event-id'], 'wh-1')
	assert.equal(verifyAppToBots([SIGNING_SECRET], 'wh-1', c.init.body, c.init.headers['x-chatdaddy-signature'], t.clock.t), true)
})

test('dedupe: a Shopify retry with the same webhook id fires once', async() => {
	const a = await t.webhook(INST_A, 'orders/create', ORDER, { id: 'wh-dup' })
	const b = await t.webhook(INST_A, 'orders/create', ORDER, { id: 'wh-dup' })
	await t.drain()
	assert.deepEqual(a.json, { accepted: true })
	assert.deepEqual(b.json, { duplicate: true })
	assert.equal(t.botsCalls.length, 1)
})

test('missing webhook id is a 400; unknown topics are acknowledged and ignored', async() => {
	const noId = await t.webhook(INST_A, 'orders/create', ORDER, { id: '' })
	assert.equal(noId.status, 400)
	const other = await t.webhook(INST_A, 'products/create', {})
	assert.deepEqual(other.json, { ignored: 'topic' })
	await t.drain()
	assert.equal(t.botsCalls.length, 0)
})

test('an order with no usable phone is acknowledged and skipped, with the reason logged (no phone in the log)', async() => {
	const r = await t.webhook(INST_A, 'orders/create', { ...ORDER, customer: { first_name: 'A' }, shipping_address: {} })
	await t.drain()
	assert.equal(r.status, 200)
	assert.equal(t.botsCalls.length, 0)
	const line = t.logs.find(l => l.msg === 'skipped')
	assert.equal(line.reason, 'no usable phone number')
	assert.equal(line.trigger, 'order-created')
	assert.ok(!JSON.stringify(t.logs).includes('9123'))
})

test('fulfillments/create -> order-fulfilled with tracking', async() => {
	await t.webhook(INST_A, 'fulfillments/create', FULFILLMENT)
	await t.drain()
	const c = t.botsCalls[0]
	assert.equal(c.url, `${BOTS_URL}/apps/triggers/${INST_A}/order-fulfilled`)
	assert.equal(c.body.trackingNumber, 'SF123456789')
	assert.equal(c.body.trackingUrl, 'https://sf.example/track/SF123456789')
})

test('fulfillments/update fires order-delivered only when delivered, and only once per fulfillment', async() => {
	const inTransit = await t.webhook(INST_A, 'fulfillments/update', { ...FULFILLMENT, shipment_status: 'in_transit' })
	assert.deepEqual(inTransit.json, { ignored: 'not delivered' })
	await t.webhook(INST_A, 'fulfillments/update', DELIVERED)
	await t.webhook(INST_A, 'fulfillments/update', DELIVERED) // Shopify re-sends with a new webhook id
	await t.drain()
	assert.equal(t.botsCalls.length, 1)
	assert.equal(t.botsCalls[0].url, `${BOTS_URL}/apps/triggers/${INST_A}/order-delivered`)
	assert.equal(t.logs.find(l => l.reason === 'already triggered').trigger, 'order-delivered')
})

test('fulfillment with no phone looks the order up through the proxy', async() => {
	t.proxy.respond = (q, v) => (/order\(id/.test(q) && v.id.endsWith('/820982911946')
		? { data: { order: { phone: '+85291234567' } } } : { data: {} })
	await t.webhook(INST_A, 'fulfillments/create', { ...FULFILLMENT, destination: { first_name: 'Ada' } })
	await t.drain()
	assert.equal(t.botsCalls[0].body.phone, '+85291234567')
})

test('fulfillment with no phone anywhere is skipped, even if the lookup fails', async() => {
	t.proxy.fail = new Error('proxy down')
	await t.webhook(INST_A, 'fulfillments/create', { ...FULFILLMENT, destination: { first_name: 'Ada' } })
	await t.drain()
	assert.equal(t.botsCalls.length, 0)
	assert.ok(t.logs.some(l => l.msg === 'order lookup failed'))
	assert.ok(t.logs.some(l => l.msg === 'skipped' && l.reason === 'no usable phone number'))
})

test('checkouts: create and update of one checkout trigger once; completed ones never', async() => {
	await t.webhook(INST_A, 'checkouts/create', CHECKOUT)
	await t.webhook(INST_A, 'checkouts/update', { ...CHECKOUT, total_price: '500.00' })
	await t.webhook(INST_A, 'checkouts/update', { ...CHECKOUT, id: 1, completed_at: '2026-10-12T10:00:00Z' })
	await t.drain()
	assert.equal(t.botsCalls.length, 1)
	const c = t.botsCalls[0]
	assert.equal(c.url, `${BOTS_URL}/apps/triggers/${INST_A}/checkout-abandoned`)
	assert.equal(c.body.checkoutUrl, CHECKOUT.abandoned_checkout_url)
	assert.equal(c.body.marketingConsent, true)
})

test('a checkout created without a phone fires when an update adds one', async() => {
	await t.webhook(INST_A, 'checkouts/create', { ...CHECKOUT, phone: null })
	await t.webhook(INST_A, 'checkouts/update', CHECKOUT)
	await t.drain()
	assert.equal(t.botsCalls.length, 1)
})

test('bots 5xx is retried and then succeeds; the event id stays the same', async() => {
	let n = 0
	t.state.response = () => new Response('', { status: ++n < 3 ? 503 : 202 })
	await t.webhook(INST_A, 'orders/create', ORDER, { id: 'wh-retry' })
	await t.drain()
	assert.equal(t.botsCalls.length, 3)
	assert.deepEqual([...new Set(t.botsCalls.map(c => c.init.headers['x-chatdaddy-event-id']))], ['wh-retry'])
})

test('a 4xx from bots is not retried; failure is logged and the semantic claim is released', async() => {
	t.state.response = () => new Response('', { status: 400 })
	await t.webhook(INST_A, 'fulfillments/update', DELIVERED)
	await t.drain()
	assert.equal(t.botsCalls.length, 1)
	assert.equal(t.logs.find(l => l.msg === 'trigger failed').reason, 'bots responded 400')
	t.state.response = () => new Response('', { status: 202 })
	await t.webhook(INST_A, 'fulfillments/update', DELIVERED) // a later delivery may try again
	await t.drain()
	assert.equal(t.botsCalls.length, 2)
})

test('bots unreachable: retried, then logged as failed', async() => {
	t.state.throwError = new Error('boom')
	await t.webhook(INST_A, 'orders/create', ORDER)
	await t.drain()
	assert.equal(t.botsCalls.length, 3)
	assert.equal(t.logs.find(l => l.msg === 'trigger failed').reason, 'bots unreachable')
})
