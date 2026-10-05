// A local stand-in for ChatDaddy, from the app's point of view: it installs the app
// (handshake with a token signed by a throwaway ES256 key), then calls its actions with
// signed requests. The trigger side is trigger-server.mjs.
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { computeHandshakeAck, signBotsToApp } from '../../template/src/signing.mjs'
import { checkProperties } from './props.mjs'

export class DevError extends Error {}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')

/**
 * Mint the token ChatDaddy sends with POST /installed: ES256, the app identity at
 * user.metadata and the team at user.teamId.
 */
export function mintInstallToken({ privateKey, appId, installationId, teamId, nowS, ttlS = 300 }) {
	const header = b64({ alg: 'ES256', typ: 'JWT' })
	const payload = b64({
		user: { id: 'chatdaddy-dev', fullName: 'chatdaddy-dev', teamId, metadata: { type: 'app', objectId: `app_${appId}/inst_${installationId}` } },
		scope: '1', iat: nowS, exp: nowS + ttlS,
	})
	const data = `${header}.${payload}`
	return `${data}.${sign('sha256', Buffer.from(data), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

/**
 * @param {object} o
 * @param {object} o.manifest the app's parsed chatdaddy-app.json
 * @param {string} o.appUrl base URL of the running app, e.g. http://localhost:3000
 * @param {string} [o.teamId]
 * @param {typeof fetch} [o.fetch]
 * @param {() => number} [o.now] unix seconds
 */
export function createDevSession({ manifest, appUrl, teamId = 'dev-team', fetch: doFetch = fetch, now = () => Math.floor(Date.now() / 1000) }) {
	// throwaway: the private key never leaves this process, only the public key is shared
	const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const session = {
		manifest,
		appId: manifest.id,
		teamId,
		installationId: randomUUID(),
		signingSecret: `whsec_dev_${randomBytes(24).toString('hex')}`,
		publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
		installed: false,
		/** trigger deliveries the local endpoint accepted: { triggerId, eventId, payload } */
		fired: [],
		base: appUrl.replace(/\/+$/, ''),
	}

	/** POST /installed; checks the status and the ack. Throws DevError with a hint. */
	session.handshake = async function handshake() {
		const nonce = randomBytes(16).toString('hex')
		const token = mintInstallToken({ privateKey: keys.privateKey, appId: session.appId, installationId: session.installationId, teamId, nowS: now() })
		const body = {
			installationId: session.installationId, teamId, appId: session.appId, appVersion: 'dev',
			grantedScopes: manifest.scopes || [], signingSecret: session.signingSecret, nonce,
		}
		let res
		try {
			res = await doFetch(`${session.base}/installed`, {
				method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
			})
		} catch(err) {
			throw new DevError(`cannot reach the app at ${session.base}: ${err.cause?.code || err.message}. Is it running?`)
		}

		const text = await res.text()
		if(res.status === 401) {
			throw new DevError('the app answered 401 to the install handshake: it did not accept the dev token. '
				+ 'Start it with CHATDADDY_DEV_PUBLIC_KEY_FILE pointing at the public key written by `dev`, and NODE_ENV not set to production.')
		}

		if(res.status !== 200) {
			throw new DevError(`install handshake: expected 200, got ${res.status} ${text.slice(0, 200)}`)
		}

		let ack
		try {
			ack = JSON.parse(text).ack
		} catch{}

		if(ack !== computeHandshakeAck(session.signingSecret, nonce)) {
			throw new DevError('install handshake: the ack is missing or wrong. It must be hex HMAC-SHA256(signingSecret, "chatdaddy/v1/handshake-ack:" + nonce).')
		}

		session.installed = true
		return { ack }
	}

	/**
	 * Call an action as ChatDaddy would: signed bots-to-app request, then check the reply
	 * against the manifest's outputProperties.
	 * @returns {Promise<{ status: number, body: unknown, ok: boolean, problems: string[], warnings: string[] }>}
	 */
	session.call = async function call(actionId, input = {}, { settings = {} } = {}) {
		const action = (manifest.flowActions || []).find(a => a.id === actionId)
		if(!action) {
			throw new DevError(`no action "${actionId}" in the manifest (declared: ${(manifest.flowActions || []).map(a => a.id).join(', ') || 'none'})`)
		}

		if(!session.installed) {
			throw new DevError('the app is not installed yet: run `handshake` first')
		}

		const warnings = []
		const inCheck = checkProperties(action.inputProperties, input, 'input')
		warnings.push(...inCheck.problems.map(p => `${p} (sent anyway)`), ...inCheck.warnings)

		const body = JSON.stringify({ input, context: { teamId, installationId: session.installationId }, settings })
		let res
		try {
			res = await doFetch(`${session.base}/actions/${encodeURIComponent(actionId)}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					// like ChatDaddy: a short-lived app token for the installation on every call
					authorization: `Bearer ${mintInstallToken({ privateKey: keys.privateKey, appId: session.appId, installationId: session.installationId, teamId, nowS: now() })}`,
					'x-chatdaddy-installation': session.installationId,
					'x-chatdaddy-signature': signBotsToApp(session.signingSecret, body, now()),
				},
				body, signal: AbortSignal.timeout(30_000),
			})
		} catch(err) {
			throw new DevError(`cannot reach the app at ${session.base}: ${err.cause?.code || err.message}`)
		}

		const text = await res.text()
		let parsed
		try {
			parsed = JSON.parse(text)
		} catch{
			parsed = text
		}

		if(res.status < 200 || res.status >= 300) {
			return { status: res.status, body: parsed, ok: false, problems: [`the app answered ${res.status}`], warnings }
		}

		const out = checkProperties(action.outputProperties, parsed, 'output')
		return { status: res.status, body: parsed, ok: out.problems.length === 0, problems: out.problems, warnings: [...warnings, ...out.warnings] }
	}

	return session
}
