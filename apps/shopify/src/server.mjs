import { createServer } from 'node:http'
import { ACTIONS } from './actions.mjs'
import { tokenMatchesInstall, verifyEs256 } from './jwt.mjs'
import { registerWebhooks, removeWebhooks } from './lifecycle.mjs'
import { orderPhone } from './queries.mjs'
import { ShopConflictError } from './store.mjs'
import { TOPIC_TRIGGERS, mapCheckout, mapFulfillment, mapOrder, verifyShopifyHmac } from './shopify.mjs'
import { computeHandshakeAck, isValidEventId, signAppToBots, verifyBotsToApp, verifyUninstalled } from './signing.mjs'

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

// An unknown installation is still checked against the real secret, so a miss runs the same
// HMAC as a hit; unknown installation and bad signature are one answer.
const parseJson = raw => {
	try {
		return JSON.parse(raw.toString('utf8'))
	} catch{
		throw new HttpError(400, 'invalid json')
	}
}

const SHOP_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/i
/** the `shop` connection input: "my-store" or "my-store.myshopify.com" -> "my-store.myshopify.com" */
export const shopDomain = v => {
	const name = `${v || ''}`.trim().toLowerCase().replace(/\.myshopify\.com$/, '')
	return SHOP_NAME.test(name) ? `${name}.myshopify.com` : undefined
}

/**
 * @param {object} deps
 * @param {string} deps.appId this app's manifest id
 * @param {string} deps.publicKey PEM, ChatDaddy's ES256 key in production
 * @param {import('./store.mjs').InstallationStore} deps.store
 * @param {string} deps.shopifyClientSecret the Shopify app's client secret: signs every webhook
 * @param {string} deps.botsUrl CHATDADDY_BOTS_URL
 * @param {string} deps.publicUrl this app's public https base URL (webhook callbacks)
 * @param {import('./proxy.mjs')} deps.proxy connection proxy (see proxy.mjs)
 * @param {(line: object) => void} [deps.log] route, installationId, status, reasons. Never bodies, phones, secrets or headers
 * @param {typeof fetch} [deps.fetch]
 * @param {() => number} [deps.now] unix seconds
 * @param {number[]} [deps.retryDelaysMs] waits between trigger delivery attempts (attempts = length + 1)
 */
export function createApp(deps) {
	const { appId, publicKey, store, shopifyClientSecret, botsUrl, publicUrl, proxy } = deps
	if(!shopifyClientSecret) {
		throw new Error('shopifyClientSecret is required')
	}

	const doFetch = deps.fetch || fetch
	const now = deps.now || (() => Math.floor(Date.now() / 1000))
	const bodyTimeoutMs = deps.bodyTimeoutMs || BODY_TIMEOUT_MS
	const retryDelays = deps.retryDelaysMs || [1000, 5000, 30_000]
	const log = deps.log || (() => {})
	// webhook work that outlives its response; tests (and shutdown) await it via server.drain()
	const pending = new Set()

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

		store.saveHandshake({ installationId, teamId, appId, signingSecret }, now())
		return { status: 200, body: { ack: computeHandshakeAck(signingSecret, nonce) }, installationId }
	}

	/** bots -> app call signed with the installation's secret; returns { installationId, raw } */
	async function botsCall(req) {
		const raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)
		const installationId = `${req.headers['x-chatdaddy-installation'] || ''}`
		const secrets = store.secretsFor(installationId, now())
		// unknown installation, bad/missing/stale signature: one answer
		if(!secrets.length || !verifyBotsToApp(secrets, raw.toString('utf8'), req.headers['x-chatdaddy-signature'], now())) {
			throw new HttpError(401, 'invalid signature')
		}

		return { installationId, raw }
	}

	// POST /actions/:actionId
	async function action(req, actionId) {
		const { installationId, raw } = await botsCall(req)
		const handler = Object.hasOwn(ACTIONS, actionId) ? ACTIONS[actionId] : undefined
		if(!handler) {
			throw new HttpError(404, 'unknown action')
		}

		const body = parseJson(raw)
		if(body?.context?.installationId !== undefined && body.context.installationId !== installationId) {
			throw new HttpError(400, 'installation mismatch')
		}

		let res
		try {
			res = await handler({ input: body?.input, settings: body?.settings, installationId, proxy })
		} catch(err) {
			log({ msg: 'action failed', actionId, installationId, reason: `${err.message}`.slice(0, 200) })
			throw new HttpError(502, 'shopify unavailable')
		}

		if(res.error) {
			throw new HttpError(400, res.error)
		}

		return { status: 200, body: res.output }
	}

	// POST /connected: the lifecycle event fired when the merchant finishes Log in with Shopify.
	// ASSUMED contract (P5 A-6 is not built): signed like an action call, body
	// { event: 'connected', installationId, connection: { id, inputs: { shop } } }.
	async function connected(req) {
		const { installationId, raw } = await botsCall(req)
		const body = parseJson(raw)
		const shop = shopDomain(body?.connection?.inputs?.shop)
		if(body?.event !== 'connected' || body.installationId !== installationId || !shop) {
			throw new HttpError(400, 'invalid body')
		}

		try {
			store.setShop(installationId, shop)
		} catch(err) {
			if(err instanceof ShopConflictError) {
				throw new HttpError(409, 'shop is linked to another installation')
			}

			throw err
		}

		try {
			const subs = await registerWebhooks({ proxy, store, installationId, publicUrl })
			return { status: 200, body: { ok: true, webhooks: subs.length }, installationId }
		} catch(err) {
			log({ msg: 'webhook registration failed', installationId, reason: `${err.message}`.slice(0, 200) })
			throw new HttpError(502, 'could not register webhooks') // so bots can retry the event
		}
	}

	// POST /shopify/webhook/:installationId
	async function shopifyWebhook(req, installationId) {
		const raw = await readBody(req, MAX_SHOPIFY_BODY_BYTES, bodyTimeoutMs)
		const verified = verifyShopifyHmac(shopifyClientSecret, raw, req.headers['x-shopify-hmac-sha256'])
		const inst = UUID.test(installationId) ? store.get(installationId) : undefined
		// the shop in the URL's installation must be the shop sending (a signed webhook from
		// store B replayed at store A's URL is refused). Unknown installation and bad signature: one answer.
		const domain = `${req.headers['x-shopify-shop-domain'] || ''}`.toLowerCase()
		if(!verified || !inst || (inst.shop && inst.shop !== domain)) {
			throw new HttpError(401, 'unauthorized')
		}

		const topic = `${req.headers['x-shopify-topic'] || ''}`
		if(!Object.hasOwn(TOPIC_TRIGGERS, topic)) {
			return { status: 200, body: { ignored: 'topic' }, installationId }
		}

		// Shopify retries reuse X-Shopify-Webhook-Id
		const webhookId = `${req.headers['x-shopify-webhook-id'] || ''}`
		if(!isValidEventId(webhookId)) {
			throw new HttpError(400, 'missing or invalid x-shopify-webhook-id')
		}

		const data = parseJson(raw)
		if(topic === 'fulfillments/update' && `${data?.shipment_status}`.toLowerCase() !== 'delivered') {
			return { status: 200, body: { ignored: 'not delivered' }, installationId }
		}

		const key = `wh:${webhookId}`
		if(!store.claim(installationId, key, now())) {
			return { status: 200, body: { duplicate: true }, installationId }
		}

		// answer now (Shopify allows 5 s), deliver after
		const job = processWebhook({ installationId, topic, webhookId, data, keys: [key] })
			.catch(err => log({ msg: 'webhook processing crashed', installationId, topic, reason: `${err.message}`.slice(0, 200) }))
			.finally(() => pending.delete(job))
		pending.add(job)
		return { status: 200, body: { accepted: true }, installationId }
	}

	async function processWebhook({ installationId, topic, webhookId, data, keys }) {
		const trigger = TOPIC_TRIGGERS[topic]
		let mapped
		if(topic === 'orders/create') {
			mapped = mapOrder(data)
		} else if(topic.startsWith('checkouts/')) {
			mapped = mapCheckout(data)
		} else {
			mapped = mapFulfillment(data)
			if(mapped.needsOrderLookup) {
				// the fulfillment's destination had no phone: ask the order (best effort)
				try {
					mapped = mapFulfillment(data, { orderPhone: await orderPhone(proxy, installationId, data.order_id) ?? '' })
				} catch(err) {
					log({ msg: 'order lookup failed', installationId, topic, reason: `${err.message}`.slice(0, 200) })
				}
			}
		}

		if(!mapped.payload) {
			// retrying cannot fix it: acknowledged, skipped
			log({ msg: 'skipped', installationId, topic, trigger, reason: mapped.skip })
			return
		}

		// one trigger per fulfillment delivery / per checkout, however many updates Shopify sends
		const once = trigger === 'order-delivered' ? `delivered:${mapped.payload.fulfillmentId}`
			: trigger === 'checkout-abandoned' ? `checkout:${mapped.payload.checkoutId}` : undefined
		if(once) {
			if(!store.claim(installationId, once, now())) {
				log({ msg: 'skipped', installationId, topic, trigger, reason: 'already triggered' })
				return
			}

			keys.push(once)
		}

		try {
			await sendTrigger(installationId, trigger, webhookId, mapped.payload)
			log({ msg: 'trigger sent', installationId, topic, trigger })
		} catch(err) {
			// give the claims back so a later delivery of the same thing can try again
			keys.forEach(k => store.release(installationId, k))
			log({ msg: 'trigger failed', installationId, topic, trigger, reason: err.message })
		}
	}

	async function sendTrigger(installationId, trigger, eventId, payload) {
		const secret = store.currentSecret(installationId)
		if(!secret) {
			throw new Error('installation gone')
		}

		const outBody = JSON.stringify(payload)
		if(Buffer.byteLength(outBody) > MAX_BODY_BYTES) {
			throw new Error('trigger payload too large')
		}

		let lastErr
		for(let attempt = 0; attempt <= retryDelays.length; attempt++) {
			if(attempt) {
				await new Promise(r => setTimeout(r, retryDelays[attempt - 1]))
			}

			try {
				const res = await doFetch(
					`${botsUrl.replace(/\/+$/, '')}/apps/triggers/${installationId}/${trigger}`,
					{
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							'x-chatdaddy-event-id': eventId, // bots de-dupes on it, so a retry never double-fires
							'x-chatdaddy-signature': signAppToBots(secret, eventId, outBody, now()),
						},
						body: outBody,
						redirect: 'error',
						signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
					}
				)
				if(res.status >= 200 && res.status < 300) {
					return
				}

				lastErr = new Error(`bots responded ${res.status}`)
				if(res.status >= 400 && res.status < 500 && res.status !== 429) {
					throw lastErr // a client error will not get better
				}
			} catch(err) {
				if(err === lastErr) {
					throw err
				}

				lastErr = new Error('bots unreachable')
			}
		}

		throw lastErr
	}

	// POST /uninstalled: signed by ChatDaddy with the installation's signing secret under its OWN
	// label (never the action label), and the signed body must name this installation
	async function uninstalled(req) {
		const raw = await readBody(req, MAX_BODY_BYTES, bodyTimeoutMs)
		const installationId = `${req.headers['x-chatdaddy-installation'] || ''}`
		const secrets = store.secretsFor(installationId, now())
		if(!secrets.length || !verifyUninstalled(secrets, raw.toString('utf8'), req.headers['x-chatdaddy-signature'], now())) {
			throw new HttpError(401, 'invalid signature')
		}

		let body
		try {
			body = JSON.parse(raw.toString('utf8'))
		} catch{}

		if(body?.event !== 'uninstalled' || body.installationId !== installationId) {
			throw new HttpError(401, 'invalid signature')
		}

		await removeWebhooks({ proxy, store, installationId, log })
		store.deleteInstallation(installationId)
		return { status: 200, body: { ok: true } }
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

		if(path === '/uninstalled') {
			return uninstalled(req)
		}

		if(path === '/connected') {
			return connected(req)
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

	// the route pattern, never the raw path; the installation id only when it is a UUID
	const ROUTES = [
		['/installed', /^\/installed$/], ['/uninstalled', /^\/uninstalled$/], ['/connected', /^\/connected$/],
		['/healthz', /^\/healthz$/], ['/actions/:actionId', /^\/actions\/[^/]+$/],
		['/shopify/webhook/:id', /^\/shopify\/webhook\/([^/]+)$/],
	]
	const logRequest = (req, out) => {
		const path = (req.url || '/').split('?')[0]
		let route = 'unknown'
		let id = out.installationId
		for(const [name, re] of ROUTES) {
			const m = re.exec(path)
			if(m) {
				route = name
				id ??= m[1]
				break
			}
		}

		id ??= req.headers['x-chatdaddy-installation']
		log({ msg: 'request', method: req.method, route, installationId: UUID.test(`${id}`) ? id : undefined, status: out.status })
	}

	const server = createServer(async(req, res) => {
		let out
		try {
			out = await route(req)
		} catch(err) {
			out = err instanceof HttpError
				? { status: err.status, body: { error: err.message }, noReply: err.noReply }
				: { status: 500, body: { error: 'internal error' } } // never echo err: it may carry secrets
		}

		try {
			logRequest(req, out)
		} catch{} // a logging failure must never cost a response

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
	server.drain = async() => {
		while(pending.size) {
			await Promise.all([...pending])
		}
	}

	return server
}
