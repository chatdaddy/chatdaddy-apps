// Fire a flow trigger: POST {botsUrl}/apps/triggers/{installationId}/{triggerId},
// signed with the installation's signing secret (the one received at /installed).
import { randomUUID } from 'node:crypto'
import { isValidEventId, signAppToBots } from './signing.mjs'

export const MAX_TRIGGER_BODY_BYTES = 64 * 1024

/**
 * @param {object} o
 * @param {string} o.botsUrl base URL of ChatDaddy's bots API, from CHATDADDY_BOTS_URL
 * @param {string} o.installationId
 * @param {string} o.triggerId an id from flowTriggers[] in chatdaddy-app.json
 * @param {object} o.payload must satisfy the trigger's payloadSchema
 * @param {string} o.secret the installation's current signing secret
 * @param {string} [o.eventId] ChatDaddy de-duplicates on this. Derive it from YOUR source
 *   event (an order id, a webhook id) so a retry of the same event never fires twice.
 *   The default is a fresh random id, i.e. "always a new event".
 * @param {typeof fetch} [o.fetch]
 * @param {number} [o.now] unix seconds, for tests
 * @returns {Promise<{ ok: boolean, status: number, body: string, eventId: string }>}
 */
export async function sendTrigger({ botsUrl, installationId, triggerId, payload, secret, eventId = randomUUID(), fetch: doFetch = fetch, now }) {
	if(!isValidEventId(eventId)) {
		throw new Error('invalid event id: 1-128 printable ASCII characters, no spaces, no "."')
	}

	const body = JSON.stringify(payload)
	if(Buffer.byteLength(body) > MAX_TRIGGER_BODY_BYTES) {
		throw new Error(`trigger payload is over ${MAX_TRIGGER_BODY_BYTES} bytes`)
	}

	const url = `${botsUrl.replace(/\/+$/, '')}/apps/triggers/${encodeURIComponent(installationId)}/${encodeURIComponent(triggerId)}`
	const res = await doFetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-chatdaddy-event-id': eventId,
			'x-chatdaddy-signature': signAppToBots(secret, eventId, body, now),
		},
		body,
		redirect: 'error',
		signal: AbortSignal.timeout(10_000),
	})
	return { ok: res.status >= 200 && res.status < 300, status: res.status, body: await res.text(), eventId }
}
