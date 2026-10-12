import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { TokenError, createContactsClient, createTokenProvider, customerToContact, fromGraphql, REPEAT_ORDERS, VIP_TOTAL_SPENT } from '../src/customers.mjs'
import { signAppToBots } from '../src/signing.mjs'
import { isCodGateway, mapOrder } from '../src/shopify.mjs'
import { CUSTOMER, ORDER } from './fixtures.mjs'
import { BOTS_URL, INST_A, INST_B, SIGNING_SECRET, TEAM, APP_ID, mintToken, startApp } from './helpers.mjs'

let t
beforeEach(async() => {
	t = await startApp()
	await t.setup()
})
afterEach(() => t.close())

const names = tags => tags.map(x => x.name).sort()
const val = (tags, name) => tags.find(x => x.name === name)?.value

test('customerToContact: fields, tags, and the VIP / repeat thresholds', () => {
	const { contact } = customerToContact({ ...CUSTOMER, last_order_date: '2026-10-01T10:00:00Z' })
	assert.equal(contact.name, 'Ada Lovelace')
	assert.equal(contact.phoneNumber, '+85291234567')
	assert.equal(contact.email, 'ada@example.com')
	assert.deepEqual(names(contact.tags), ['shopify last order date', 'shopify marketing consent', 'shopify order count', 'shopify total spent', 'shopify-customer', 'shopify-repeat', 'shopify-vip'])
	assert.equal(val(contact.tags, 'shopify total spent'), '650.00')
	assert.equal(val(contact.tags, 'shopify order count'), '3')
	assert.equal(val(contact.tags, 'shopify marketing consent'), 'true')
	assert.equal(val(contact.tags, 'shopify last order date'), '2026-10-01T10:00:00Z')

	const edge = (total_spent, orders_count) => names(customerToContact({ ...CUSTOMER, total_spent, orders_count }).contact.tags).filter(n => /vip|repeat/.test(n))
	assert.deepEqual(edge(`${VIP_TOTAL_SPENT}`, REPEAT_ORDERS), ['shopify-repeat', 'shopify-vip'])
	assert.deepEqual(edge(`${VIP_TOTAL_SPENT - 0.01}`, REPEAT_ORDERS - 1), [])
})

test('customerToContact: no usable phone is skipped; a bare number needs the address country', () => {
	assert.deepEqual(customerToContact({ ...CUSTOMER, default_address: null }), { skip: 'no usable phone number' })
	assert.deepEqual(customerToContact({ ...CUSTOMER, phone: 'soon', default_address: {} }), { skip: 'no usable phone number' })
	assert.equal(customerToContact({ ...CUSTOMER, phone: '+44 20 7946 0958' }).contact.phoneNumber, '+442079460958')
})

test('fromGraphql maps the Admin API customer to the same contact', () => {
	const c = customerToContact(fromGraphql({
		firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', phone: null,
		defaultAddress: { phone: '9123 4567', countryCodeV2: 'HK' }, amountSpent: { amount: '650.00' }, numberOfOrders: '3',
		lastOrder: { processedAt: '2026-10-01T10:00:00Z' }, smsMarketingConsent: { marketingState: 'NOT_SUBSCRIBED' },
	})).contact
	assert.equal(val(c.tags, 'shopify marketing consent'), 'false')
	assert.equal(val(c.tags, 'shopify last order date'), '2026-10-01T10:00:00Z')
	assert.ok(names(c.tags).includes('shopify-vip'))
})

test('customers/update webhook upserts the contact with a token from getAppToken', async() => {
	t.proxy.respond = () => ({ data: { customer: { lastOrder: { processedAt: '2026-10-02T00:00:00Z' } }, abandonedCheckouts: { nodes: [] } } })
	const r = await t.webhook(INST_A, 'customers/update', CUSTOMER)
	assert.equal(r.status, 200)
	await t.drain()
	assert.equal(t.contacts.upserts.length, 1)
	const [{ token, items }] = t.contacts.upserts
	assert.equal(token, 'app-tok')
	assert.equal(items[0].phoneNumber, '+85291234567')
	assert.equal(val(items[0].tags, 'shopify last order date'), '2026-10-02T00:00:00Z')
	assert.equal(t.botsCalls.length, 0, 'no trigger is fired for a customer')
})

test('customer webhook: no phone is skipped, a failed token fetch writes nothing', async() => {
	await t.webhook(INST_A, 'customers/create', { ...CUSTOMER, default_address: null })
	await t.drain()
	assert.equal(t.contacts.upserts.length, 0)
	assert.ok(t.logs.some(l => l.msg === 'skipped' && l.topic === 'customers/create'))

	t.state.tokenError = Object.assign(new Error('x'), { status: 503 })
	await t.webhook(INST_A, 'customers/create', CUSTOMER)
	await t.drain()
	assert.equal(t.contacts.upserts.length, 0)
	assert.ok(t.logs.some(l => /app token unavailable/.test(l.msg) && l.status === 503))
})

test('connected backfills recent customers after responding, paged through the proxy', async() => {
	const node = i => ({ legacyResourceId: `${i}`, firstName: 'C', lastName: `${i}`, phone: `+8529123${1000 + i}`, amountSpent: { amount: '10' }, numberOfOrders: '1' })
	let page = 0
	t.proxy.respond = (q, v) => {
		if(!/customers\(first/.test(q)) {
			return { data: {} }
		}

		page++
		return { data: { customers: { nodes: [node(page), { ...node(99), phone: null }], pageInfo: { hasNextPage: page < 2, endCursor: `cur${page}` } } } }
	}

	const r = await t.botsPost('/connected', { event: 'connected', installationId: INST_A, connection: { id: 'shopify', inputs: { shop: 'test-shop' } } },
		{ headers: { authorization: `Bearer ${mintToken()}` } })
	assert.equal(r.status, 200)
	await t.drain()
	const pages = t.proxy.calls.filter(c => /customers\(first/.test(c.query))
	assert.deepEqual(pages.map(c => c.variables.after), [null, 'cur1'])
	assert.equal(t.contacts.upserts.length, 1)
	assert.equal(t.contacts.upserts[0].items.length, 2) // the phone-less customers are skipped
})

const complianceBody = (topic, extra = {}) => ({
	event: 'compliance', topic, installationId: INST_A, teamId: TEAM, appId: APP_ID, shop: 'test-shop.myshopify.com',
	payload: { shop_id: 1, shop_domain: 'test-shop.myshopify.com', customer: { id: 207119551, email: 'ada@example.com', phone: '9123 4567' }, ...extra },
})

test('customers/redact clears the synced fields and tags on that customer\'s contact', async() => {
	const r = await t.botsPost('/compliance', complianceBody('customers/redact', { customer: { id: 1, phone: '+852 9123 4567' } }))
	assert.equal(r.status, 200)
	assert.equal(t.contacts.finds[0].q, '+85291234567')
	const [p] = t.contacts.patches
	assert.deepEqual(p.ids, ['c1'])
	assert.ok(p.tags.every(x => x.remove === true))
	assert.deepEqual(names(p.tags), ['shopify last order date', 'shopify marketing consent', 'shopify order count', 'shopify total spent', 'shopify-customer', 'shopify-repeat', 'shopify-vip'])
})

test('customers/redact: a failed token fetch is a 503 so Shopify retries; a wrong shop or signature is refused; data_request is acknowledged', async() => {
	t.state.tokenError = new Error('route 500')
	assert.equal((await t.botsPost('/compliance', complianceBody('customers/redact'))).status, 503)
	assert.equal(t.contacts.patches.length, 0)
	t.state.tokenError = undefined
	const h = {}
	assert.equal((await t.botsPost('/compliance', { ...complianceBody('customers/redact'), shop: 'other.myshopify.com' }, h)).status, 400)
	assert.equal((await t.botsPost('/compliance', complianceBody('customers/redact'), { ...h, secret: 'wrong' })).status, 401)
	assert.equal((await t.botsPost('/compliance', complianceBody('customers/redact'), { ...h, installationId: INST_B })).status, 401)
	assert.equal((await t.botsPost('/compliance', complianceBody('customers/data_request'))).status, 200)
	assert.equal(t.contacts.patches.length, 0)
})

test('shop/redact deletes the shop\'s app-side state but keeps the installation', async() => {
	assert.equal(t.store.webhooksFor(INST_A).length, 7)
	assert.equal((await t.botsPost('/compliance', complianceBody('shop/redact'))).status, 200)
	assert.deepEqual(t.store.webhooksFor(INST_A), [])
	assert.equal(t.store.get(INST_A).shop, null)
	assert.ok(t.store.get(INST_A).signingSecret)
})

test('contacts client: bearer token on every call, upsert body and chunking', async() => {
	const calls = []
	const c = createContactsClient({ baseUrl: 'https://im.test', fetch: async(url, init) => { calls.push({ url, init }); return new Response('{"contacts":[{"id":"x1"}]}') } })
	await c.upsert('tok', Array.from({ length: 501 }, (_, i) => ({ name: `n${i}`, phoneNumber: `+1${i}` })))
	assert.equal(calls.length, 2)
	assert.equal(calls[0].url, 'https://im.test/contacts/upsert')
	assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
	assert.equal(JSON.parse(calls[0].init.body).contacts.length, 500)
	assert.deepEqual(await c.findIds('tok', '+1 2'), ['x1'])
	assert.match(calls[2].url, /\/contacts\?q=%2B1%202/)
	await c.patchTags('tok', ['a', 'b'], [{ name: 'n', remove: true }])
	assert.equal(calls[3].url, 'https://im.test/contacts?contacts=a&contacts=b')
})

test('COD filter: isCod follows the payment gateway names', () => {
	for(const g of ['Cash on Delivery (COD)', 'cash_on_delivery', 'COD', 'cod']) {
		assert.equal(isCodGateway(g), true, g)
	}

	for(const g of ['shopify_payments', 'manual', 'Bank Deposit', 'codex']) {
		assert.equal(isCodGateway(g), false, g)
	}

	assert.equal(mapOrder(ORDER).payload.isCod, true)
	assert.equal(mapOrder({ ...ORDER, payment_gateway_names: ['shopify_payments'] }).payload.isCod, false)
})

test('getAppToken: signed like a trigger delivery, exact body, cached to expiresAt - 60 s, one shared in-flight request', async() => {
	const calls = []
	let clockMs = Date.now()
	let release
	const gate = new Promise(r => { release = r })
	const fetchFake = async(url, init) => {
		calls.push({ url, init })
		await gate
		return new Response(JSON.stringify({ accessToken: `tok${calls.length}`, expiresAt: new Date(clockMs + 300_000).toISOString() }))
	}

	const get = createTokenProvider({ store: t.store, botsUrl: `${BOTS_URL}/`, fetch: fetchFake, nowMs: () => clockMs })
	await t.handshake()
	const both = Promise.all([get(INST_A), get(INST_A)])
	release()
	assert.deepEqual(await both, ['tok1', 'tok1'])
	assert.equal(calls.length, 1, 'concurrent callers share one request')

	const { url, init } = calls[0]
	assert.equal(url, `${BOTS_URL}/app-installations/${INST_A}/token`)
	assert.equal(init.body, JSON.stringify({ purpose: 'app-token', installationId: INST_A }))
	assert.equal(init.headers['content-type'], 'application/json')
	const eventId = init.headers['x-chatdaddy-event-id']
	assert.equal(init.headers['x-chatdaddy-signature'], signAppToBots(SIGNING_SECRET, eventId, init.body, Math.floor(clockMs / 1000)))

	clockMs += 200_000
	assert.equal(await get(INST_A), 'tok1', 'cache hit before expiresAt - 60 s')
	clockMs += 45_000 // 245 s: past 300 - 60
	assert.equal(await get(INST_A), 'tok2')
	assert.equal(calls.length, 2)
})

test('getAppToken: a non-2xx answer throws its status (and never the token or body)', async() => {
	const get = createTokenProvider({ store: t.store, botsUrl: BOTS_URL, fetch: async() => new Response('{"error":"nope","accessToken":"leak"}', { status: 429 }) })
	await t.handshake()
	await assert.rejects(get(INST_A), err => err instanceof TokenError && err.status === 429 && !/leak/.test(err.message))
	await assert.rejects(createTokenProvider({ store: t.store, botsUrl: BOTS_URL })(INST_B), TokenError) // no secret for an unknown installation
})
