import assert from 'node:assert/strict'
import { ProxyError } from '../src/proxy.mjs'
import { afterEach, beforeEach, test } from 'node:test'
import { INST_A, INST_B, startApp } from './helpers.mjs'

let t
beforeEach(async() => {
	t = await startApp()
	await t.setup()
})
afterEach(() => t.close())

const call = (id, input, opts) => t.botsPost(`/actions/${id}`, { input, context: { installationId: INST_A }, settings: {} }, opts)

test('is-checkout-open: open, completed and unknown checkouts', async() => {
	const nodes = {
		'111': { id: 'gid://shopify/AbandonedCheckout/111', completedAt: null, abandonedCheckoutUrl: 'https://s/c/111' },
		'222': { id: 'gid://shopify/AbandonedCheckout/222', completedAt: '2026-10-12T10:00:00Z', abandonedCheckoutUrl: 'https://s/c/222' },
	}
	t.proxy.respond = (q, v) => ({ data: { abandonedCheckouts: { nodes: [nodes[v.q.replace('id:', '')]].filter(Boolean) } } })
	assert.deepEqual((await call('is-checkout-open', { checkoutId: '111' })).json, { isOpen: true, checkoutUrl: 'https://s/c/111' })
	assert.deepEqual((await call('is-checkout-open', { checkoutId: '222' })).json, { isOpen: false, checkoutUrl: 'https://s/c/222' })
	assert.deepEqual((await call('is-checkout-open', { checkoutId: '333' })).json, { isOpen: false, checkoutUrl: '' })
	assert.equal(t.proxy.calls.at(-1).installationId, INST_A)
})

test('is-checkout-open: needs a numeric checkoutId; a Shopify failure is a 502, not a lie', async() => {
	assert.equal((await call('is-checkout-open', {})).status, 400)
	assert.equal((await call('is-checkout-open', { checkoutId: '1; drop' })).status, 400)
	t.proxy.fail = new ProxyError('connection gone')
	assert.equal((await call('is-checkout-open', { checkoutId: '111' })).status, 502)
	// a bug (not the proxy) is a 500 with its own log line
	t.proxy.fail = new TypeError('oops')
	assert.equal((await call('is-checkout-open', { checkoutId: '111' })).status, 500)
	assert.ok(t.logs.some(l => l.msg === 'action crashed (bug)'))
})

test('get-latest-order-for-contact: finds the customer by normalised phone, then their latest order', async() => {
	t.proxy.respond = (q, v) => (v.q === 'phone:+85291234567' ? { data: { customers: { nodes: [{ id: 'gid://shopify/Customer/55', orders: { nodes: [{
		legacyResourceId: '820982911946', name: '#1001', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
		statusPageUrl: 'https://s/status', totalPriceSet: { shopMoney: { amount: '410.00', currencyCode: 'HKD' } },
		lineItems: { nodes: [{ title: 'Shirt', quantity: 2 }] },
		fulfillments: [{ trackingInfo: [{ company: 'SF Express', number: 'SF1', url: 'https://sf/SF1' }] }],
	}] } }] } } } : { data: { customers: { nodes: [] } } })

	const before = t.proxy.calls.length
	const r = await call('get-latest-order-for-contact', { phone: '9123 4567', countryCode: 'HK' })
	assert.equal(r.status, 200)
	assert.equal(t.proxy.calls.length - before, 1) // customer and order in one query
	assert.deepEqual(r.json, {
		found: true, orderId: '820982911946', orderNumber: '#1001', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED',
		total: '410.00', currency: 'HKD', itemsSummary: '2 x Shirt', trackingCompany: 'SF Express', trackingNumber: 'SF1',
		trackingUrl: 'https://sf/SF1', orderStatusUrl: 'https://s/status',
	})
})

test('get-latest-order-for-contact: no customer or no orders is found:false; a bad phone is a 400', async() => {
	assert.deepEqual((await call('get-latest-order-for-contact', { phone: '+85291234567' })).json, { found: false })
	t.proxy.respond = () => ({ data: { customers: { nodes: [{ id: 'gid://shopify/Customer/1', orders: { nodes: [] } }] } } })
	assert.deepEqual((await call('get-latest-order-for-contact', { phone: '+85291234567' })).json, { found: false })
	assert.equal((await call('get-latest-order-for-contact', { phone: 'soon' })).status, 400)
})

test('actions need a valid bots signature for a known installation, and know their ids', async() => {
	assert.equal((await call('is-checkout-open', { checkoutId: '1' }, { secret: 'wrong' })).status, 401)
	assert.equal((await call('is-checkout-open', { checkoutId: '1' }, { installationId: INST_B })).status, 401)
	assert.equal((await call('nope', {})).status, 404)
	assert.equal((await call('constructor', {})).status, 404)
})
