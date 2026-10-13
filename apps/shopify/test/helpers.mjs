import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { ProxyError } from '../src/proxy.mjs'
import { createApp } from '../src/server.mjs'
import { signBotsToApp, signUninstalled } from '../src/signing.mjs'
import { InstallationStore } from '../src/store.mjs'

export const APP_ID = 'chatdaddy-shopify'
export const CLIENT_SECRET = 'shpss_test_app_client_secret'
export const BOTS_URL = 'https://bots.test.invalid'
export const PUBLIC_URL = 'https://app.test.invalid'
export const INST_A = '11111111-1111-4111-8111-111111111111'
export const INST_B = '22222222-2222-4222-8222-222222222222'
export const TEAM = 'team-1'
export const SIGNING_SECRET = 'whsec_test_installation_secret'

export const chatdaddyKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
export const pem = k => k.publicKey.export({ type: 'spki', format: 'pem' })

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const nowS = () => Math.floor(Date.now() / 1000)

/** shape of auth's appAccessTokenPost token */
export function mintToken({ appId = APP_ID, installationId = INST_A, teamId = TEAM, exp = nowS() + 300 } = {}) {
	const data = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({
		user: { id: 'svc', fullName: 'svc', teamId, metadata: { type: 'app', objectId: `app_${appId}/inst_${installationId}` } },
		scope: '1', iat: nowS(), exp,
	})}`
	return `${data}.${sign('sha256', Buffer.from(data), { key: chatdaddyKeys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

export const shopifyHmac = (secret, raw) => createHmac('sha256', secret).update(raw).digest('base64')

/**
 * Recording fake of the connection proxy. `respond(query, variables)` answers a call; webhook
 * subscriptions are kept in `subs` so listing after creating behaves like Shopify.
 */
export function fakeProxy() {
	const calls = []
	const subs = []
	const p = {
		calls, subs, respond: undefined, fail: undefined,
		async graphql({ installationId, query, variables }) {
			calls.push({ installationId, query, variables })
			if(p.fail) {
				throw p.fail
			}

			if(/webhookSubscriptions\(/.test(query)) {
				return { data: { webhookSubscriptions: { nodes: subs.filter(x => x.endpoint.callbackUrl === variables.url), pageInfo: { hasNextPage: false } } } }
			}

			if(/webhookSubscriptionCreate/.test(query)) {
				const data = {}
				for(const m of query.matchAll(/(a\d+): webhookSubscriptionCreate\(topic: \$(t\d+), webhookSubscription: \$(s\d+)/g)) {
					const sub = {
						id: `gid://shopify/WebhookSubscription/${subs.length + 1}`, topic: variables[m[2]],
						endpoint: { callbackUrl: variables[m[3]].callbackUrl },
					}
					subs.push(sub)
					data[m[1]] = { webhookSubscription: { id: sub.id }, userErrors: [] }
				}

				return { data }
			}

			if(/webhookSubscriptionDelete/.test(query)) {
				return { data: {} }
			}

			return p.respond ? p.respond(query, variables) : { data: {} }
		},
	}
	return p
}

/** recording fake of the ChatDaddy contacts client; `ids` is what findIds answers */
export function fakeContacts() {
	const c = { upserts: [], patches: [], finds: [], ids: ['c1'] }
	c.upsert = async(token, items) => { c.upserts.push({ token, items }) }
	c.findIds = async(token, q) => { c.finds.push({ token, q }); return c.ids }
	c.patchTags = async(token, ids, tags) => { c.patches.push({ token, ids, tags }) }
	return c
}

/** boots the app on an ephemeral port with a recording fake fetch (= bots) and fake proxy */
export async function startApp(overrides = {}) {
	const store = new InstallationStore(undefined)
	const clock = { t: nowS() }
	const botsCalls = []
	const state = { response: () => new Response('{"fired":1}', { status: 202 }), throwError: undefined, tokenError: undefined }
	const logs = []
	const proxy = fakeProxy()
	const contacts = fakeContacts()
	const server = createApp({
		appId: APP_ID, publicKey: pem(chatdaddyKeys), store, shopifyClientSecret: CLIENT_SECRET, botsUrl: BOTS_URL,
		publicUrl: PUBLIC_URL, proxy, contacts, getAppToken: async() => { if(state.tokenError) { throw state.tokenError } return 'app-tok' }, now: () => clock.t, retryDelaysMs: [0, 0], log: l => logs.push(l),
		fetch: async(url, init) => {
			botsCalls.push({ url, init, body: JSON.parse(init.body) })
			if(state.throwError) {
				throw state.throwError
			}

			return state.response()
		},
		...overrides,
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${server.address().port}`
	const post = async(path, body, headers = {}) => {
		const res = await fetch(base + path, {
			method: 'POST', body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
			headers: { 'content-type': 'application/json', ...headers },
		})
		const text = await res.text()
		let json
		try {
			json = JSON.parse(text)
		} catch{}

		return { status: res.status, json, text }
	}

	const handshake = (installationId = INST_A, secret = SIGNING_SECRET) => post(
		'/installed',
		{ installationId, teamId: TEAM, appId: APP_ID, appVersion: '1.0.0', grantedScopes: [], signingSecret: secret, nonce: 'n-1' },
		{ authorization: `Bearer ${mintToken({ installationId })}` }
	)
	/** a call signed like bots -> app */
	const botsPost = (path, body, { installationId = INST_A, secret = SIGNING_SECRET, label = 'bots', headers = {} } = {}) => {
		const raw = JSON.stringify(body)
		const sig = (label === 'bots' ? signBotsToApp : signUninstalled)(secret, raw, clock.t)
		return post(path, raw, { 'x-chatdaddy-installation': installationId, 'x-chatdaddy-signature': sig, ...headers })
	}
	/** a Shopify webhook, signed with `secret` unless `signature` is given */
	const webhook = (installationId, topic, body, {
		id = `wh-${Math.random().toString(36).slice(2)}`, secret = CLIENT_SECRET, signature, shop = 'test-shop.myshopify.com',
	} = {}) => {
		const raw = JSON.stringify(body)
		return post(`/shopify/webhook/${installationId}`, raw, {
			'x-shopify-topic': topic, 'x-shopify-webhook-id': id, 'x-shopify-shop-domain': shop,
			'x-shopify-hmac-sha256': signature ?? shopifyHmac(secret, raw),
		})
	}
	const setup = async(shop = 'test-shop') => {
		await handshake()
		await botsPost('/connected', { event: 'connected', installationId: INST_A, connection: { id: 'shopify', inputs: { shop } } })
	}
	return {
		server, base, store, clock, botsCalls, state, logs, proxy, contacts, post, handshake, botsPost, webhook, setup,
		drain: () => server.drain(),
		close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)) },
	}
}
