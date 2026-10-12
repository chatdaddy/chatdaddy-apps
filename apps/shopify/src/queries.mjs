// Shopify Admin GraphQL used by actions and lookups. ASSUMED (not run against a real shop, no
// Shopify access yet): AbandonedCheckout / abandonedCheckouts and the search filters below.
// Verify against the Admin GraphQL docs with the first real store, see README "Assumptions".
import { gql } from './proxy.mjs'

const gid = (type, id) => `gid://shopify/${type}/${id}`
const money = set => ({ amount: set?.shopMoney?.amount ?? '', currency: set?.shopMoney?.currencyCode ?? '' })

/** @returns {{ found: boolean, isOpen: boolean, checkoutUrl: string }} open = exists and not completed */
export async function checkoutStatus(proxy, installationId, checkoutId) {
	const data = await gql(proxy, installationId, `
		query($q: String!) { abandonedCheckouts(first: 1, query: $q) { nodes { id completedAt abandonedCheckoutUrl } } }
	`, { q: `id:${checkoutId}` })
	const node = data.abandonedCheckouts?.nodes?.find(n => n.id === gid('AbandonedCheckout', checkoutId) || n.id.endsWith(`/${checkoutId}`))
	return {
		found: Boolean(node),
		isOpen: Boolean(node && !node.completedAt),
		checkoutUrl: node?.abandonedCheckoutUrl || '',
	}
}

const ORDER_FIELDS = `
	legacyResourceId name displayFinancialStatus displayFulfillmentStatus statusPageUrl
	totalPriceSet { shopMoney { amount currencyCode } }
	lineItems(first: 10) { nodes { title quantity } }
	fulfillments(first: 5) { trackingInfo { company number url } }
`

/** latest order of the customer with this E.164 phone; undefined when there is none */
export async function latestOrderByPhone(proxy, installationId, phone) {
	const customers = await gql(proxy, installationId, `
		query($q: String!) { customers(first: 1, query: $q) { nodes { id } } }
	`, { q: `phone:${phone}` })
	const customerId = customers.customers?.nodes?.[0]?.id
	if(!customerId) {
		return undefined
	}

	const orders = await gql(proxy, installationId, `
		query($q: String!) { orders(first: 1, query: $q, sortKey: PROCESSED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }
	`, { q: `customer_id:${customerId.split('/').pop()}` })
	const o = orders.orders?.nodes?.[0]
	if(!o) {
		return undefined
	}

	const { amount, currency } = money(o.totalPriceSet)
	const tracking = (o.fulfillments || []).flatMap(f => f.trackingInfo || []).find(t => t.number || t.url) || {}
	return {
		orderId: `${o.legacyResourceId}`,
		orderNumber: o.name,
		financialStatus: o.displayFinancialStatus || '',
		fulfillmentStatus: o.displayFulfillmentStatus || '',
		total: amount,
		currency,
		itemsSummary: (o.lineItems?.nodes || []).map(i => `${i.quantity} x ${i.title}`).join(', '),
		trackingCompany: tracking.company || '',
		trackingNumber: tracking.number || '',
		trackingUrl: tracking.url || '',
		orderStatusUrl: o.statusPageUrl || '',
	}
}

/** the order's own phone, for fulfillment webhooks whose destination has none */
export async function orderPhone(proxy, installationId, orderId) {
	const data = await gql(proxy, installationId, `
		query($id: ID!) { order(id: $id) { phone customer { phone } shippingAddress { phone countryCodeV2 } billingAddress { phone countryCodeV2 } } }
	`, { id: gid('Order', orderId) })
	const o = data.order
	return o && (o.phone || o.customer?.phone || o.shippingAddress?.phone || o.billingAddress?.phone || undefined)
}
