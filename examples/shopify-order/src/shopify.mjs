import { createHmac, timingSafeEqual } from 'node:crypto'

export const TRIGGER_ID = 'shopify-order-created'

/**
 * Shopify: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(webhookSecret, rawBodyBytes)).
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

/**
 * Maps a Shopify orders/create payload to the flow trigger payload declared in
 * chatdaddy-app.json (flowTriggers[].payloadSchema). Field sources follow the
 * ChatDaddy's built-in Shopify trigger.
 * @returns the payload, or undefined when there is no order id or no phone
 */
export function mapOrder(order) {
	if(!order || typeof order !== 'object') {
		return undefined
	}

	const orderId = str(order.order_number ?? order.id)
	const phone = str(
		order.customer?.phone
		|| order.customer?.default_address?.phone
		|| order.phone
		|| order.billing_address?.phone
		|| order.shipping_address?.phone
	)
	if(!orderId || !phone) {
		return undefined
	}

	const name = [
		str(order.customer?.first_name || order.billing_address?.first_name || order.shipping_address?.first_name),
		str(order.customer?.last_name || order.billing_address?.last_name || order.shipping_address?.last_name),
	].filter(Boolean).join(' ')

	const items = Array.isArray(order.line_items) ? order.line_items : []
	let itemsSummary = items.map(i => `${Number(i?.quantity) || 1} x ${str(i?.title)}`).join(', ')
	if(itemsSummary.length > ITEMS_SUMMARY_MAX) {
		itemsSummary = `${itemsSummary.slice(0, ITEMS_SUMMARY_MAX - 3)}...`
	}

	return {
		orderId,
		customerName: name,
		phone,
		total: str(order.total_price),
		currency: str(order.currency),
		itemsSummary,
	}
}
