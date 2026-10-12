// Shopify Admin GraphQL used by actions and lookups. ASSUMED (not run against a real shop, no
// Shopify access yet): AbandonedCheckout / abandonedCheckouts and the search filters below.
// Verify against the Admin GraphQL docs with the first real store, see README "Assumptions".
import { gql } from './proxy.mjs'

// numeric Shopify ids only: they end up inside a search string / a gid, so never anything else
const checkEntityId = id => {
	if(!/^\d{1,20}$/.test(`${id}`)) {
		throw new TypeError('invalid Shopify id')
	}
}
const gid = (type, id) => `gid://shopify/${type}/${id}`
const money = set => ({ amount: set?.shopMoney?.amount ?? '', currency: set?.shopMoney?.currencyCode ?? '' })

/** @returns {{ found: boolean, isOpen: boolean, checkoutUrl: string }} open = exists and not completed */
export async function checkoutStatus(proxy, installationId, checkoutId) {
	checkEntityId(checkoutId)
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

/** latest order of the customer with this E.164 phone (one query); undefined when there is none */
export async function latestOrderByPhone(proxy, installationId, phone) {
	const data = await gql(proxy, installationId, `
		query($q: String!) {
			customers(first: 1, query: $q) {
				nodes {
					id
					orders(first: 1, sortKey: PROCESSED_AT, reverse: true) {
						nodes {
							legacyResourceId name displayFinancialStatus displayFulfillmentStatus statusPageUrl
							totalPriceSet { shopMoney { amount currencyCode } }
							lineItems(first: 10) { nodes { title quantity } }
							fulfillments(first: 5) { trackingInfo { company number url } }
						}
					}
				}
			}
		}
	`, { q: `phone:${phone}` })
	const o = data.customers?.nodes?.[0]?.orders?.nodes?.[0]
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
	checkEntityId(orderId)
	const data = await gql(proxy, installationId, `
		query($id: ID!) { order(id: $id) { phone customer { phone } shippingAddress { phone countryCodeV2 } billingAddress { phone countryCodeV2 } } }
	`, { id: gid('Order', orderId) })
	const o = data.order
	return o && (o.phone || o.customer?.phone || o.shippingAddress?.phone || o.billingAddress?.phone || undefined)
}
