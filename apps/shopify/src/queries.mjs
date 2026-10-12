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

const orderGid = id => {
	checkEntityId(id)
	return gid('Order', id)
}
const userErrors = list => (list || []).map(e => e.message).join('; ').slice(0, 300)

/** add tags to an order (Admin GraphQL tagsAdd, needs write_orders); tags are variables, never interpolated */
export async function tagOrder(proxy, installationId, orderId, tags) {
	const data = await gql(proxy, installationId, `
		mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { message } } }
	`, { id: orderGid(orderId), tags })
	const r = data.tagsAdd
	return r?.node?.id && !r.userErrors?.length ? { success: true, message: '' } : { success: false, message: userErrors(r?.userErrors) || 'not tagged' }
}

/**
 * Cancel an order for the customer (Admin GraphQL orderCancel, needs write_orders): reason CUSTOMER,
 * restock the items, refund only when asked, no email to the customer from Shopify.
 * ponytail: unverified against a live store; confirm once the Partner dev store exists
 * (recalled from the Admin API: orderId, reason, refund and restock are required; the result is a
 * job plus orderCancelUserErrors).
 */
export async function cancelOrder(proxy, installationId, orderId, { refund = false, restock = true } = {}) {
	const data = await gql(proxy, installationId, `
		mutation($id: ID!, $refund: Boolean!, $restock: Boolean!) {
			orderCancel(orderId: $id, reason: CUSTOMER, refund: $refund, restock: $restock, notifyCustomer: false) {
				job { id } orderCancelUserErrors { message }
			}
		}
	`, { id: orderGid(orderId), refund, restock })
	const r = data.orderCancel
	return r?.job?.id && !r.orderCancelUserErrors?.length ? { success: true, message: '' } : { success: false, message: userErrors(r?.orderCancelUserErrors) || 'not cancelled' }
}
