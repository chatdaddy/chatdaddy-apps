import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { InstallationStore } from '../src/store.mjs'
import { ORDER } from './fixtures.mjs'
import { INST_A, INST_B, PUBLIC_URL, TEAM, APP_ID, mintToken, startApp } from './helpers.mjs'

let t
beforeEach(async() => {
	t = await startApp()
})
afterEach(() => t.close())

const connect = (shop = 'test-shop', opts) => t.botsPost(
	'/connected', { event: 'connected', installationId: INST_A, connection: { id: 'shopify', inputs: { shop } } }, opts
)
const TOPICS = ['CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE', 'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', 'ORDERS_CREATE']

test('handshake stores the installation and acks; a wrong app is refused', async() => {
	const ok = await t.handshake()
	assert.equal(ok.status, 200)
	assert.match(ok.json.ack, /^[0-9a-f]{64}$/)
	const bad = await t.post('/installed', { installationId: INST_A, teamId: TEAM, appId: 'other', signingSecret: 'x', nonce: 'n' },
		{ authorization: `Bearer ${mintToken()}` })
	assert.equal(bad.status, 401)
})

test('connected registers one webhook per topic at this installation\'s URL, and stores shop + ids', async() => {
	await t.handshake()
	const r = await connect('My-Store')
	assert.deepEqual(r.json, { ok: true, webhooks: 5 })
	const creates = t.proxy.calls.filter(c => c.variables?.topic)
	assert.deepEqual(creates.map(c => c.variables.topic).sort(), TOPICS)
	for(const c of creates) {
		assert.equal(c.installationId, INST_A)
		assert.deepEqual(c.variables.sub, { callbackUrl: `${PUBLIC_URL}/shopify/webhook/${INST_A}`, format: 'JSON' })
	}

	assert.equal(t.store.get(INST_A).shop, 'my-store.myshopify.com')
	assert.equal(t.store.installationForShop('my-store.myshopify.com'), INST_A)
	assert.equal(t.store.webhooksFor(INST_A).length, 5)
})

test('a repeated connected does not create the webhooks twice', async() => {
	await t.handshake()
	await connect()
	await connect('test-shop.myshopify.com')
	assert.equal(t.proxy.calls.filter(c => c.variables?.topic).length, 5)
	assert.equal(t.proxy.subs.length, 5)
})

test('connected: bad signature 401, bad shop 400, shop already linked elsewhere 409, proxy failure 502', async() => {
	await t.handshake()
	await t.handshake(INST_B, 'whsec_other')
	assert.equal((await connect('test-shop', { secret: 'wrong' })).status, 401)
	assert.equal((await connect('not a shop!')).status, 400)
	assert.equal((await connect('')).status, 400)
	assert.equal((await connect('test-shop')).status, 200)
	const other = await t.botsPost('/connected', { event: 'connected', installationId: INST_B, connection: { inputs: { shop: 'test-shop' } } },
		{ installationId: INST_B, secret: 'whsec_other' })
	assert.equal(other.status, 409)
	t.proxy.fail = new Error('proxy down')
	assert.equal((await connect('second-shop')).status, 502)
})

test('connected, then a webhook for that shop works end to end; another shop\'s domain is refused', async() => {
	await t.setup('test-shop')
	assert.equal((await t.webhook(INST_A, 'orders/create', ORDER)).status, 200)
	assert.equal((await t.webhook(INST_A, 'orders/create', ORDER, { shop: 'x.myshopify.com' })).status, 401)
})

test('uninstalled removes the webhooks at Shopify and every row; a bad label or id is refused', async() => {
	await t.setup()
	await t.webhook(INST_A, 'orders/create', ORDER, { id: 'wh-1' })
	await t.drain()
	const body = { event: 'uninstalled', installationId: INST_A, teamId: TEAM, appId: APP_ID }
	// an action-labelled signature must not work as an uninstall
	assert.equal((await t.botsPost('/uninstalled', body, { label: 'bots' })).status, 401)
	assert.equal((await t.botsPost('/uninstalled', { ...body, installationId: INST_B }, { label: 'uninstalled' })).status, 401)
	assert.equal(t.store.get(INST_A) !== undefined, true)
	const r = await t.botsPost('/uninstalled', body, { label: 'uninstalled' })
	assert.equal(r.status, 200)
	const deletes = t.proxy.calls.filter(c => /webhookSubscriptionDelete/.test(c.query))
	assert.equal(deletes.length, 5)
	assert.equal(t.store.get(INST_A), undefined)
	assert.deepEqual(t.store.webhooksFor(INST_A), [])
	assert.equal(t.store.installationForShop('test-shop.myshopify.com'), undefined)
	assert.equal(t.store.claim(INST_A, 'wh:wh-1', t.clock.t), true) // dedupe rows are gone too
	assert.equal((await t.webhook(INST_A, 'orders/create', ORDER)).status, 401)
})

test('uninstalled still deletes local state when Shopify can no longer be reached', async() => {
	await t.setup()
	t.proxy.fail = new Error('connection deleted')
	const r = await t.botsPost('/uninstalled', { event: 'uninstalled', installationId: INST_A }, { label: 'uninstalled' })
	assert.equal(r.status, 200)
	assert.equal(t.store.get(INST_A), undefined)
	assert.ok(t.logs.some(l => l.msg === 'webhook removal failed'))
})

test('SQLite store: state survives a reopen; a re-handshake keeps the shop and demotes the old secret', () => {
	const file = join(mkdtempSync(join(tmpdir(), 'shopify-store-')), 'app.db')
	const a = new InstallationStore(file)
	a.saveHandshake({ installationId: INST_A, teamId: TEAM, appId: APP_ID, signingSecret: 's1' }, 1000)
	a.setShop(INST_A, 'x.myshopify.com')
	a.saveWebhooks(INST_A, [{ topic: 'orders/create', id: 'gid://1' }])
	assert.equal(a.claim(INST_A, 'k', 1000), true)
	a.saveHandshake({ installationId: INST_A, teamId: TEAM, appId: APP_ID, signingSecret: 's2' }, 2000)
	a.db.close()
	const b = new InstallationStore(file)
	assert.equal(b.get(INST_A).shop, 'x.myshopify.com')
	assert.deepEqual(b.secretsFor(INST_A, 2001), ['s2', 's1'])
	assert.deepEqual(b.secretsFor(INST_A, 2000 + 16 * 60), ['s2'])
	assert.deepEqual(b.webhooksFor(INST_A), [{ topic: 'orders/create', id: 'gid://1' }])
	assert.equal(b.claim(INST_A, 'k', 1001), false)
	assert.equal(b.claim(INST_A, 'k', 1000 + 8 * 24 * 3600), true) // pruned after a week
})
