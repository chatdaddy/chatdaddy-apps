import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createApp } from '../src/server.mjs'
import { InstallationStore } from '../src/store.mjs'

export const manifest = JSON.parse(readFileSync(new URL('../chatdaddy-app.json', import.meta.url), 'utf8'))
export const APP_ID = manifest.id
export const INST_A = '11111111-1111-4111-8111-111111111111'
export const INST_B = '22222222-2222-4222-8222-222222222222'
export const TEAM = 'team-1'

/** throwaway ES256 key pairs; production uses ChatDaddy's published key */
export const chatdaddyKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
export const otherKeys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
export const pem = k => k.publicKey.export({ type: 'spki', format: 'pem' })

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
const nowS = () => Math.floor(Date.now() / 1000)

/** the shape of the token ChatDaddy sends with POST /installed */
export function mintToken({
	appId = APP_ID, installationId = INST_A, teamId = TEAM, exp = nowS() + 300, keys = chatdaddyKeys, metadata, headerAlg = 'ES256',
} = {}) {
	const header = b64({ alg: headerAlg, typ: 'JWT' })
	const payload = b64({
		user: {
			id: 'svc', fullName: 'svc', teamId,
			metadata: metadata || { type: 'app', objectId: `app_${appId}/inst_${installationId}` },
		},
		scope: '1', iat: nowS(), exp,
	})
	const data = `${header}.${payload}`
	const sig = headerAlg === 'none' ? '' : sign('sha256', Buffer.from(data), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
	return `${data}.${sig}`
}

/** boots the app on an ephemeral port, with an in-memory store and a controllable clock */
export async function startApp(overrides = {}) {
	const store = new InstallationStore(undefined)
	const clock = { t: nowS() }
	const server = createApp({ appId: APP_ID, getPublicKey: () => pem(chatdaddyKeys), store, now: () => clock.t, ...overrides })
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${server.address().port}`
	const post = async(path, body, headers = {}) => {
		const res = await fetch(base + path, {
			method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
			headers: { 'content-type': 'application/json', ...headers },
			signal: AbortSignal.timeout(5000), // a server that never answers fails the test instead of hanging it
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
		body || { installationId, teamId: TEAM, appId: APP_ID, appVersion: '1.0.0', grantedScopes: manifest.scopes, signingSecret: secret, nonce },
		{ authorization: `Bearer ${token ?? mintToken({ installationId })}` }
	)
	return { base, store, clock, post, handshake, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)) } }
}
