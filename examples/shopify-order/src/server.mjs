import { createServer } from 'node:http'
import { ACTIONS } from './actions.mjs'
import { tokenMatchesInstall, verifyEs256 } from './jwt.mjs'
import { TRIGGER_ID, mapOrder, verifyShopifyHmac } from './shopify.mjs'
import { computeHandshakeAck, isValidEventId, signAppToBots, verifyBotsToApp } from './signing.mjs'

export const MAX_BODY_BYTES = 64 * 1024 // handshake / action calls, and bots' trigger cap
export const MAX_SHOPIFY_BODY_BYTES = 1024 * 1024
const OUTBOUND_TIMEOUT_MS = 10_000
// a request body must arrive within this; a slow drip can't hold a socket and buffers
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
 * @param {string} deps.publicKey PEM, ChatDaddy's ES256 key in production
 * @param {import('./store.mjs').InstallationStore} deps.store
 * @param {string} deps.shopifyWebhookSecret
 * @param {string} deps.botsUrl CHATDADDY_BOTS_URL
 * @param {typeof fetch} [deps.fetch]
 * @param {() => number} [deps.now] unix seconds
 */
export function createApp(deps) {
	const { appId, publicKey, store, shopifyWebhookSecret, botsUrl } = deps
	const doFetch = deps.fetch || fetch
	const now = deps.now || (() => Math.floor(Date.now() / 1000))
	const bodyTimeoutMs = deps.bodyTimeoutMs || BODY_TIMEOUT_MS

	// POST /installed
	async function handshake(req) {
		const raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)
		const auth = req.headers.authorization || ''
		const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
		const payload = verifyEs256(token, publicKey, now())
		if(!payload) {
			throw new HttpError(401, 'unauthorized')
		}

		const body = parseJson(raw)
		const { installationId, teamId, signingSecret, nonce } = body || {}
		const claims = { appId: body?.appId, installationId, teamId }
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

	// POST /actions/:actionId
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

	// POST /shopify/webhook/:installationId
	async function shopifyWebhook(req, installationId) {
		const raw = await readBody(req, MAX_SHOPIFY_BODY_BYTES, bodyTimeoutMs)
		if(!verifyShopifyHmac(shopifyWebhookSecret, raw, req.headers['x-shopify-hmac-sha256'])) {
			throw new HttpError(401, 'invalid signature')
		}

		if(req.headers['x-shopify-topic'] !== 'orders/create') {
			return { status: 200, body: { ignored: 'topic' } }
		}

		const secret = UUID.test(installationId) ? store.currentSecret(installationId) : undefined
		if(!secret) {
			throw new HttpError(404, 'unknown installation')
		}

		// Shopify retries reuse X-Shopify-Webhook-Id, so bots de-dupes on it
		const eventId = `${req.headers['x-shopify-webhook-id'] || ''}`
		if(!isValidEventId(eventId)) {
			throw new HttpError(400, 'missing or invalid x-shopify-webhook-id')
		}

		const payload = mapOrder(parseJson(raw))
		if(!payload) {
			// retrying cannot fix an order with no phone/number: acknowledge it
			return { status: 200, body: { skipped: 'order has no phone or number' } }
		}

		const outBody = JSON.stringify(payload)
		if(Buffer.byteLength(outBody) > MAX_BODY_BYTES) {
			throw new HttpError(413, 'trigger payload too large')
		}

		let res
		try {
			res = await doFetch(
				`${botsUrl.replace(/\/+$/, '')}/apps/triggers/${installationId}/${TRIGGER_ID}`,
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-chatdaddy-event-id': eventId,
						'x-chatdaddy-signature': signAppToBots(secret, eventId, outBody, now()),
					},
					body: outBody,
					redirect: 'error',
					signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
				}
			)
		} catch{
			throw new HttpError(502, 'bots unreachable')
		}

		// non-2xx -> 502 so Shopify retries; the stable event id keeps retries from double-firing
		if(res.status < 200 || res.status >= 300) {
			throw new HttpError(502, `bots responded ${res.status}`)
		}

		return { status: 200, body: { forwarded: true } }
	}

	async function route(req) {
		const url = new URL(req.url || '/', 'http://x')
		const path = url.pathname
		if(req.method === 'GET' && path === '/healthz') {
			return { status: 200, body: { ok: true } }
		}

		if(req.method !== 'POST') {
			throw new HttpError(404, 'not found')
		}

		let m
		if(path === '/installed') {
			return handshake(req)
		}

		if((m = /^\/actions\/([^/]+)$/.exec(path))) {
			const actionId = decodeURIComponent(m[1])
			if(!ACTION_ID.test(actionId)) {
				throw new HttpError(404, 'unknown action')
			}

			return action(req, actionId)
		}

		if((m = /^\/shopify\/webhook\/([^/]+)$/.exec(path))) {
			return shopifyWebhook(req, decodeURIComponent(m[1]))
		}

		throw new HttpError(404, 'not found')
	}

	return createServer(async(req, res) => {
		let out
		try {
			out = await route(req)
		} catch(err) {
			out = err instanceof HttpError
				? { status: err.status, body: { error: err.message }, noReply: err.noReply }
				: { status: 500, body: { error: 'internal error' } } // never echo err: it may carry secrets
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
