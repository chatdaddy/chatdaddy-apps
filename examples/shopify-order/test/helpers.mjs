import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { createApp } from '../src/server.mjs'
import { InstallationStore } from '../src/store.mjs'

export const APP_ID = 'shopify-order-whatsapp'
export const SHOPIFY_SECRET = 'shpss_test_webhook_secret'
export const BOTS_URL = 'https://bots.test.invalid'
export const INST_A = '11111111-1111-4111-8111-111111111111'
export const INST_B = '22222222-2222-4222-8222-222222222222'
export const TEAM = 'team-1'

/** throwaway ES256 keypairs; production uses ChatDaddy's published key */
export const chatdaddyKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
export const otherKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
export const pem = k => k.publicKey.export({ type: 'spki', format: 'pem' })

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const nowS = () => Math.floor(Date.now() / 1000)

/** shape of auth's appAccessTokenPost token: user.metadata + user.teamId */
export function mintToken({
	appId = APP_ID, installationId = INST_A, teamId = TEAM, exp = nowS() + 300,
	alg = 'ES256', headerAlg = alg, keys = chatdaddyKeys, metadata, userTeamId = teamId,
} = {}) {
	const header = b64({ alg: headerAlg, typ: 'JWT' })
	const payload = b64({
		user: {
			id: 'svc', fullName: 'svc', teamId: userTeamId,
			metadata: metadata || { type: 'app', objectId: `app_${appId}/inst_${installationId}` },
		},
		scope: '1', iat: nowS(), exp,
	})
	const data = `${header}.${payload}`
	const sig = headerAlg === 'none' ? '' : sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
	return `${data}.${sig}`
}

export const shopifyHmac = (secret, raw) => createHmac('sha256', secret).update(raw).digest('base64')

/** boots the app on an ephemeral port with a recording fake fetch */
export async function startApp(overrides = {}) {
	const store = new InstallationStore(undefined)
	const clock = { t: nowS() }
	const calls = []
	const state = { response: () => new Response('{"fired":1}', { status: 202 }), throwError: undefined }
	const fakeFetch = async(url, init) => {
		calls.push({ url, init })
		if(state.throwError) {
			throw state.throwError
		}

		return state.response()
	}

	const server = createApp({
		appId: APP_ID, publicKey: pem(chatdaddyKeys), store, shopifyWebhookSecret: SHOPIFY_SECRET,
		botsUrl: BOTS_URL, fetch: fakeFetch, now: () => clock.t, ...overrides,
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

	const handshake = (secret, { nonce = 'n-1', installationId = INST_A, token, body } = {}) => post(
		'/installed',
		body || { installationId, teamId: TEAM, appId: APP_ID, appVersion: '1.0.0', grantedScopes: ['ACCOUNT_READ'], signingSecret: secret, nonce },
		{ authorization: `Bearer ${token ?? mintToken({ installationId })}` }
	)
	return { store, clock, calls, state, post, handshake, close: () => new Promise(r => server.close(r)) }
}

export const SAMPLE_ORDER = {
	id: 820982911946154500, order_number: 1001, currency: 'USD', total_price: '41.90',
	customer: { first_name: 'Ada', last_name: 'Lovelace', phone: '+447700900123' },
	line_items: [{ title: 'Shirt', quantity: 2 }, { title: 'Hat', quantity: 1 }],
}
