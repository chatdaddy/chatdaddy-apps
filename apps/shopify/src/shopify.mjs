import { createHmac, timingSafeEqual } from 'node:crypto'
import { normalizePhone } from './phone.mjs'

/** Shopify webhook topic -> trigger id (chatdaddy-app.json flowTriggers[].id) */
export const TOPIC_TRIGGERS = {
	'orders/create': 'order-created',
	'fulfillments/create': 'order-fulfilled',
	'fulfillments/update': 'order-delivered',
	'checkouts/create': 'checkout-abandoned',
	'checkouts/update': 'checkout-abandoned',
}

/** customer sync topics (S-4): not triggers, they write ChatDaddy contacts */
export const CUSTOMER_TOPICS = ['customers/create', 'customers/update']

/**
 * Shopify: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(appClientSecret, rawBodyBytes)).
 * @param {string} secret
 * @param {Buffer} rawBody the exact bytes received
 * @param {string | undefined} header
 */
export function verifyShopifyHmac(secret, rawBody, header) {
	if(!secret || typeof header !== 'string') {
		return false
	}

	const expected = createHmac('sha256', secret).update(rawBody).digest()
	const received = Buffer.from(header, 'base64')
	return received.length === expected.length && timingSafeEqual(expected, received)
}

const str = (v, max = 512) => (v === undefined || v === null ? '' : `${v}`.trim().slice(0, max))
const ITEMS_SUMMARY_MAX = 2000

const itemsOf = list => (Array.isArray(list) ? list : [])
function itemsSummary(items) {
	const s = itemsOf(items).map(i => `${Number(i?.quantity) || 1} x ${str(i?.title ?? i?.name)}`).join(', ')
	return s.length > ITEMS_SUMMARY_MAX ? `${s.slice(0, ITEMS_SUMMARY_MAX - 3)}...` : s
}

const fullName = (...people) => {
	for(const p of people) {
		const n = [str(p?.first_name), str(p?.last_name)].filter(Boolean).join(' ')
		if(n) {
			return n
		}
	}

	return ''
}

/**
 * First usable phone. `sources` is [{ phone, country_code }] best first; every country_code
 * seen is a hint for the others, since one address often lacks the country of another.
 */
export function pickPhone(sources) {
	const hints = sources.map(s => s?.country_code).filter(Boolean)
	for(const s of sources) {
		const p = normalizePhone(s?.phone, s?.country_code, ...hints)
		if(p) {
			return p
		}
	}

	return undefined
}

// WhatsApp marketing needs opt-in: any of Shopify's consent signals counts. ASSUMED field names
// (REST webhook shapes, see test/fixtures): buyer_accepts_marketing, customer.accepts_marketing,
// customer.{email,sms}_marketing_consent.state.
const marketingConsent = o => Boolean(
	o?.buyer_accepts_marketing || o?.accepts_marketing || o?.customer?.accepts_marketing
	|| o?.customer?.sms_marketing_consent?.state === 'subscribed'
	|| o?.customer?.email_marketing_consent?.state === 'subscribed'
)

// ponytail: Shopify's generic "manual" gateway is not treated as COD (it is also bank transfer etc.)
export const isCodGateway = g => /cash[ _]on[ _]delivery|\bcod\b/i.test(g)

const SKIP_NO_PHONE = { skip: 'no usable phone number' }

/** orders/create -> order-created payload, or { skip: reason } */
export function mapOrder(order) {
	if(!order || typeof order !== 'object' || (order.id === undefined && order.order_number === undefined)) {
		return { skip: 'no order id' }
	}

	const phone = pickPhone([
		{ phone: order.phone, country_code: order.shipping_address?.country_code },
		{ phone: order.customer?.phone, country_code: order.customer?.default_address?.country_code },
		{ phone: order.shipping_address?.phone, country_code: order.shipping_address?.country_code },
		{ phone: order.billing_address?.phone, country_code: order.billing_address?.country_code },
		{ phone: order.customer?.default_address?.phone, country_code: order.customer?.default_address?.country_code },
	])
	if(!phone) {
		return SKIP_NO_PHONE
	}

	const gateways = itemsOf(order.payment_gateway_names).map(g => str(g))
	return {
		payload: {
			orderId: str(order.id ?? order.order_number),
			orderNumber: str(order.name || (order.order_number ? `#${order.order_number}` : '')),
			customerName: fullName(order.customer, order.billing_address, order.shipping_address),
			phone,
			email: str(order.contact_email || order.email || order.customer?.email),
			itemsSummary: itemsSummary(order.line_items),
			itemCount: itemsOf(order.line_items).reduce((n, i) => n + (Number(i?.quantity) || 1), 0),
			subtotal: str(order.subtotal_price),
			total: str(order.total_price),
			currency: str(order.currency),
			paymentGateway: gateways.join(', '),
			isCod: gateways.some(isCodGateway),
			financialStatus: str(order.financial_status),
			orderStatusUrl: str(order.order_status_url),
			marketingConsent: marketingConsent(order),
		},
	}
}

// "#1001.1" is the fulfillment name; the order is "#1001"
const orderNameOf = f => str(f.name).replace(/\.\d+$/, '')

/**
 * fulfillments/create and fulfillments/update -> order-fulfilled / order-delivered payload.
 * The payload carries `destination` (the shipping address) rather than the customer, so the
 * phone may be missing: the caller can then look the order up (see queries.mjs) and pass
 * `orderPhone`.
 */
export function mapFulfillment(f, { orderPhone } = {}) {
	if(!f || typeof f !== 'object' || f.id === undefined) {
		return { skip: 'no fulfillment id' }
	}

	const phone = pickPhone([
		{ phone: f.destination?.phone, country_code: f.destination?.country_code },
		{ phone: f.phone },
		{ phone: orderPhone },
	])
	if(!phone) {
		return { ...SKIP_NO_PHONE, needsOrderLookup: orderPhone === undefined && f.order_id !== undefined }
	}

	const numbers = itemsOf(f.tracking_numbers)
	const urls = itemsOf(f.tracking_urls)
	return {
		payload: {
			orderId: str(f.order_id),
			orderNumber: orderNameOf(f),
			fulfillmentId: str(f.id),
			customerName: fullName(f.destination),
			phone,
			email: str(f.email),
			itemsSummary: itemsSummary(f.line_items),
			trackingCompany: str(f.tracking_company),
			trackingNumber: str(f.tracking_number || numbers[0]),
			trackingUrl: str(f.tracking_url || urls[0], 2048),
			shipmentStatus: str(f.shipment_status),
		},
	}
}

/** checkouts/create and checkouts/update -> checkout-abandoned payload */
export function mapCheckout(c) {
	if(!c || typeof c !== 'object' || c.id === undefined) {
		return { skip: 'no checkout id' }
	}

	if(c.completed_at) {
		return { skip: 'checkout already completed' }
	}

	if(!c.abandoned_checkout_url) {
		return { skip: 'no checkout url' }
	}

	const phone = pickPhone([
		{ phone: c.phone, country_code: c.shipping_address?.country_code },
		{ phone: c.customer?.phone, country_code: c.customer?.default_address?.country_code },
		{ phone: c.shipping_address?.phone, country_code: c.shipping_address?.country_code },
		{ phone: c.billing_address?.phone, country_code: c.billing_address?.country_code },
	])
	if(!phone) {
		return SKIP_NO_PHONE
	}

	return {
		payload: {
			checkoutId: str(c.id),
			customerName: fullName(c.customer, c.shipping_address, c.billing_address),
			phone,
			email: str(c.email || c.customer?.email),
			checkoutUrl: str(c.abandoned_checkout_url, 2048),
			itemsSummary: itemsSummary(c.line_items),
			total: str(c.total_price),
			currency: str(c.currency),
			marketingConsent: marketingConsent(c),
		},
	}
}
