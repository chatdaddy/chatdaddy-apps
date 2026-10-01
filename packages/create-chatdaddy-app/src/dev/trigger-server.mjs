// The local stand-in for ChatDaddy's trigger endpoint:
//   POST /apps/triggers/{installationId}/{triggerId}
// It applies the checks ChatDaddy applies and prints what would fire: installation
// known, trigger declared in the manifest, event id well-formed, app-to-bots signature
// valid over the raw body (bound to the event id), body <= 64 KB, JSON object matching
// the trigger's payloadSchema. Responses match ChatDaddy's: 202 { fired, throttled,
// failed } for a delivery, and 200 { duplicate: true } for an event id the
// installation already delivered (ChatDaddy de-duplicates per installation + event
// id for 10 minutes; here, for the whole dev session).
import { createServer } from 'node:http'
import { isValidEventId, verifyAppToBots } from '../../template/src/signing.mjs'
import { unsupportedKeywords, validate } from '../validate/index.mjs'

export const MAX_TRIGGER_BODY_BYTES = 64 * 1024
// like the scaffold: a body must arrive within this, so a slow client can't hold a socket
export const TRIGGER_BODY_TIMEOUT_MS = 10_000

/**
 * @param {object} o
 * @param {ReturnType<import('./session.mjs').createDevSession>} o.session
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now] unix seconds
 */
export function createTriggerServer({ session, log = () => {}, now = () => Math.floor(Date.now() / 1000), bodyTimeoutMs = TRIGGER_BODY_TIMEOUT_MS }) {
	const seen = new Set()
	const warnedKeywords = new Set()

	function reply(res, status, body) {
		const text = JSON.stringify(body)
		res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
		res.end(text)
	}

	const handle = async(req, res) => {
		const m = /^\/apps\/triggers\/([^/]+)\/([^/]+)$/.exec(new URL(req.url || '/', 'http://x').pathname)
		if(req.method !== 'POST' || !m) {
			return reply(res, 404, { error: 'not found' })
		}

		const [installationId, triggerId] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])]
		const refuse = (status, why) => {
			log(`REFUSED ${triggerId} (${status}): ${why}`)
			return reply(res, status, { error: why })
		}

		if(Number(req.headers['content-length']) > MAX_TRIGGER_BODY_BYTES) {
			res.setHeader('connection', 'close')
			return refuse(413, `payload over ${MAX_TRIGGER_BODY_BYTES} bytes`)
		}

		const timer = setTimeout(() => req.destroy(), bodyTimeoutMs)
		const chunks = []
		let size = 0
		try {
			for await (const chunk of req) {
				size += chunk.length
				if(size > MAX_TRIGGER_BODY_BYTES) {
					res.setHeader('connection', 'close')
					return refuse(413, `payload over ${MAX_TRIGGER_BODY_BYTES} bytes`)
				}

				chunks.push(chunk)
			}
		} finally {
			clearTimeout(timer)
		}

		const raw = Buffer.concat(chunks).toString('utf8')
		const trigger = (session.manifest.flowTriggers || []).find(t => t.id === triggerId)
		if(installationId !== session.installationId) {
			return refuse(404, 'unknown installation (this dev session installed a different id)')
		}

		if(!session.installed) {
			return refuse(404, 'the app is not installed in this dev session yet')
		}

		if(!trigger) {
			return refuse(404, `unknown trigger "${triggerId}" (not in flowTriggers of the manifest)`)
		}

		const eventId = `${req.headers['x-chatdaddy-event-id'] || ''}`
		if(!isValidEventId(eventId)) {
			return refuse(400, 'missing or invalid x-chatdaddy-event-id (1-128 printable ASCII, no spaces, no ".")')
		}

		if(!verifyAppToBots(session.signingSecret, eventId, raw, req.headers['x-chatdaddy-signature'], now())) {
			return refuse(401, 'invalid signature (app-to-bots: secret, event id, timestamp within 300s, exact body bytes)')
		}

		let payload
		try {
			payload = JSON.parse(raw)
		} catch{
			return refuse(400, 'body is not valid JSON')
		}

		if(payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
			return refuse(400, 'body must be a JSON object')
		}

		const errors = validate(trigger.payloadSchema, payload)
		if(errors.length) {
			return refuse(400, `payload does not match payloadSchema: ${errors.map(e => e.message).join('; ')}`)
		}

		for(const kw of unsupportedKeywords(trigger.payloadSchema)) {
			if(!warnedKeywords.has(kw)) {
				warnedKeywords.add(kw)
				log(`note: payloadSchema keyword not checked by the dev server: ${kw}`)
			}
		}

		const key = `${installationId}.${eventId}`
		if(seen.has(key)) {
			log(`DUPLICATE ${triggerId} event ${eventId}: acknowledged, would not fire again`)
			return reply(res, 200, { duplicate: true })
		}

		seen.add(key)
		session.fired.push({ triggerId, eventId, payload })
		log(`WOULD FIRE ${triggerId} (event ${eventId}) for installation ${installationId}: ${raw}`)
		return reply(res, 202, { fired: 1, throttled: 0, failed: 0 })
	}

	// every unexpected error is a 500, never an unhandled rejection that ends the session
	const server = createServer((req, res) => {
		handle(req, res).catch(err => {
			log(`ERROR handling ${req.method} ${req.url}: ${err?.message || err}`)
			if(!res.headersSent && !res.destroyed && !req.destroyed) {
				reply(res, 500, { error: 'internal error in the dev server' })
			}
		})
	})

	return {
		server,
		/** @returns the bound port */
		listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => {
			server.once('error', reject)
			server.listen(port, host, () => resolve(server.address().port))
		}),
		close: () => new Promise(r => server.close(r)),
	}
}
