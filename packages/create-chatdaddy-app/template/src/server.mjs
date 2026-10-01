import { createServer } from 'node:http'
import { ACTIONS } from './actions.mjs'
import { tokenMatchesInstall, verifyEs256 } from './jwt.mjs'
import { computeHandshakeAck, verifyBotsToApp } from './signing.mjs'

export const MAX_BODY_BYTES = 64 * 1024
// a request body must arrive within this; a slow drip can't hold a socket open
export const BODY_TIMEOUT_MS = 10_000
// action ids are manifest slugs; anything else (e.g. a decoded '/') is refused up front
const ACTION_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class HttpError extends Error {
	constructor(status, message, { noReply = false } = {}) {
		super(message)
		this.status = status
		// the socket is already gone (the body timed out): nothing to answer
		this.noReply = noReply
	}
}

async function readBody(req, limit, timeoutMs = BODY_TIMEOUT_MS) {
	// a declared length over the limit is refused before reading anything
	if(Number(req.headers['content-length']) > limit) {
		throw new HttpError(413, 'payload too large')
	}

	const timer = setTimeout(() => req.destroy(new HttpError(408, 'request body timeout', { noReply: true })), timeoutMs)
	const chunks = []
	let size = 0
	try {
		for await (const chunk of req) {
			size += chunk.length
			if(size > limit) {
				// stop reading now; the 413 reply closes the connection (see below)
				throw new HttpError(413, 'payload too large')
			}

			chunks.push(chunk)
		}
	} finally {
		clearTimeout(timer)
	}

	return Buffer.concat(chunks)
}

const parseJson = raw => {
	try {
		return JSON.parse(raw.toString('utf8'))
	} catch{
		throw new HttpError(400, 'invalid json')
	}
}

/**
 * @param {object} deps
 * @param {string} deps.appId this app's manifest id
 * @param {() => string} deps.getPublicKey PEM that verifies the handshake token (see keys.mjs)
 * @param {import('./store.mjs').InstallationStore} deps.store
 * @param {() => number} [deps.now] unix seconds
 * @param {(level: string, msg: string, extra?: object) => void} [deps.log] structured log sink (see log.mjs)
 * @param {number} [deps.bodyTimeoutMs] request body timeout; tests shorten it
 */
export function createApp(deps) {
	const { appId, getPublicKey, store } = deps
	const now = deps.now || (() => Math.floor(Date.now() / 1000))
	const log = deps.log || (() => {})
	const bodyTimeoutMs = deps.bodyTimeoutMs || BODY_TIMEOUT_MS

	// POST /installed: ChatDaddy tells the app a team installed it
	async function handshake(req) {
		const raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)
		const auth = req.headers.authorization || ''
		const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
		const payload = verifyEs256(token, getPublicKey(), now())
		if(!payload) {
			throw new HttpError(401, 'unauthorized')
		}

		const body = parseJson(raw)
		const { installationId, teamId, signingSecret, nonce } = body || {}
		const claims = { appId: body?.appId, installationId, teamId }
		// the token must be for THIS app, THIS installation and THIS team
		if(body?.appId !== appId || !tokenMatchesInstall(payload, claims)) {
			throw new HttpError(401, 'unauthorized')
		}

		if(
			typeof installationId !== 'string' || !UUID.test(installationId)
			|| typeof teamId !== 'string' || !teamId
			|| typeof signingSecret !== 'string' || !signingSecret
			|| typeof nonce !== 'string' || !nonce
		) {
			throw new HttpError(400, 'invalid body')
		}

		await store.saveHandshake({ installationId, teamId, appId, signingSecret }, now())
		return { status: 200, body: { ack: computeHandshakeAck(signingSecret, nonce) } }
	}

	// POST /actions/:actionId: a flow runs one of the app's actions
	async function action(req, actionId) {
		const raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)
		const installationId = `${req.headers['x-chatdaddy-installation'] || ''}`
		const secrets = store.secretsFor(installationId, now())
		// unknown installation, bad/missing/stale signature: one answer
		if(!secrets.length || !verifyBotsToApp(secrets, raw.toString('utf8'), req.headers['x-chatdaddy-signature'], now())) {
			throw new HttpError(401, 'invalid signature')
		}

		const handler = Object.hasOwn(ACTIONS, actionId) ? ACTIONS[actionId] : undefined
		if(!handler) {
			throw new HttpError(404, 'unknown action')
		}

		const body = parseJson(raw)
		if(body?.context?.installationId !== undefined && body.context.installationId !== installationId) {
			throw new HttpError(400, 'installation mismatch')
		}

		const res = handler(body?.input, body?.settings)
		if(res.error) {
			throw new HttpError(400, res.error)
		}

		return { status: 200, body: res.output }
	}

	async function route(req) {
		const path = new URL(req.url || '/', 'http://x').pathname
		if(req.method === 'GET' && path === '/healthz') {
			return { status: 200, body: { ok: true } }
		}

		if(req.method !== 'POST') {
			throw new HttpError(404, 'not found')
		}

		if(path === '/installed') {
			return handshake(req)
		}

		const m = /^\/actions\/([^/]+)$/.exec(path)
		if(m) {
			const actionId = decodeURIComponent(m[1])
			if(!ACTION_ID.test(actionId)) {
				throw new HttpError(404, 'unknown action')
			}

			return action(req, actionId)
		}

		throw new HttpError(404, 'not found')
	}

	return createServer(async(req, res) => {
		let out
		try {
			out = await route(req)
		} catch(err) {
			if(err instanceof HttpError) {
				out = { status: err.status, body: { error: err.message }, noReply: err.noReply }
			} else {
				log('error', 'unexpected error', { error: err?.message })
				out = { status: 500, body: { error: 'internal error' } } // never echo err to the client: it may carry secrets
			}
		}

		if(out.noReply) {
			return
		}

		const text = JSON.stringify(out.body)
		res.writeHead(out.status, {
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(text),
			// a 413 left the body unread: close the connection so the rest of the upload is dropped
			...(out.status === 413 ? { connection: 'close' } : {}),
		})
		res.end(text)
	})
}
