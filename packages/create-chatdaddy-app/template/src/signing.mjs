// ChatDaddy's direction-labelled HMAC signing for app traffic. Do not change the
// byte format: test/signing.test.mjs pins vectors generated from ChatDaddy's own
// signing code, and ChatDaddy rejects anything that differs.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const APP_SIGNING_LABELS = {
	appToBots: 'chatdaddy/v1/app-to-bots',
	botsToApp: 'chatdaddy/v1/bots-to-app',
	handshakeAck: 'chatdaddy/v1/handshake-ack',
}

export const APP_SIGNATURE_TOLERANCE_S = 5 * 60

// 1-128 printable ASCII, no space, and no '.' (it is the '.'-joined dedup key)
const EVENT_ID_REGEX = /^[\x21-\x2d\x2f-\x7e]{1,128}$/

const hmacHex = (secret, content) => createHmac('sha256', secret).update(content).digest('hex')

function hexEqual(expectedHex, receivedHex) {
	const expected = Buffer.from(expectedHex, 'hex')
	const received = Buffer.from(receivedHex, 'hex')
	return expected.length === received.length && timingSafeEqual(expected, received)
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

export const isValidEventId = eventId => typeof eventId === 'string' && EVENT_ID_REGEX.test(eventId)

const appToBotsContent = (t, eventId, body) => `${APP_SIGNING_LABELS.appToBots}.${t}.${eventId}.${body}`
const botsToAppContent = (t, body) => `${APP_SIGNING_LABELS.botsToApp}.${t}.${body}`

/** app -> bots: header for a trigger call */
export function signAppToBots(secret, eventId, body, timestampS = nowSeconds()) {
	if(!isValidEventId(eventId)) {
		throw new Error('invalid event id')
	}

	return `t=${timestampS},v1=${hmacHex(secret, appToBotsContent(timestampS, eventId, body))}`
}

/** bots -> app: used only by tests and `create-chatdaddy-app dev`, standing in for ChatDaddy */
export function signBotsToApp(secret, body, timestampS = nowSeconds()) {
	return `t=${timestampS},v1=${hmacHex(secret, botsToAppContent(timestampS, body))}`
}

/** what this app does with an action call. `secrets`: current plus unexpired previous */
export function verifyBotsToApp(secrets, body, header, nowS = nowSeconds(), toleranceS = APP_SIGNATURE_TOLERANCE_S) {
	return verifyHeader(secrets, header, nowS, toleranceS, t => botsToAppContent(t, body))
}

/** what ChatDaddy does with a trigger call (used by tests and `create-chatdaddy-app dev`) */
export function verifyAppToBots(secrets, eventId, body, header, nowS = nowSeconds(), toleranceS = APP_SIGNATURE_TOLERANCE_S) {
	if(!isValidEventId(eventId)) {
		return false
	}

	return verifyHeader(secrets, header, nowS, toleranceS, t => appToBotsContent(t, eventId, body))
}

/** hex HMAC-SHA256(secret, "chatdaddy/v1/handshake-ack:" + nonce) */
export const computeHandshakeAck = (secret, nonce) => hmacHex(secret, `${APP_SIGNING_LABELS.handshakeAck}:${nonce}`)

function verifyHeader(secrets, header, nowS, toleranceS, contentFor) {
	const parts = parseSignatureHeader(header)
	if(!parts) {
		return false
	}

	const timestampS = Number(parts.t)
	if(!Number.isSafeInteger(timestampS) || Math.abs(nowS - timestampS) > toleranceS) {
		return false
	}

	const content = contentFor(timestampS)
	let ok = false // every candidate is checked, no early exit
	for(const secret of Array.isArray(secrets) ? secrets : [secrets]) {
		ok = hexEqual(hmacHex(secret, content), parts.v1) || ok
	}

	return ok
}

/** strict: exactly `t=<digits>,v1=<64 hex>`, each once */
function parseSignatureHeader(header) {
	const parts = (typeof header === 'string' ? header : '').split(',')
	if(parts.length !== 2) {
		return undefined
	}

	const map = {}
	for(const part of parts) {
		const idx = part.indexOf('=')
		const key = part.slice(0, idx)
		if(idx <= 0 || key in map) {
			return undefined
		}

		map[key] = part.slice(idx + 1)
	}

	if(!/^\d+$/.test(map.t || '') || !/^[0-9a-f]{64}$/.test(map.v1 || '')) {
		return undefined
	}

	return { t: map.t, v1: map.v1 }
}
