// S-4 customer sync: Shopify customer -> ChatDaddy contact (fields + tags), backfill, redact.
// ChatDaddy has no separate custom-field object: a "custom field" is a contact tag that carries a
// value ({ name, value }, im `ContactTagUpdate`), so fields and tags are both written as tags.
// ASSUMED (not run against a live team, see README): that an upsert with a valued tag creates the
// field without a prior tagsPost, and that a patch tag with `remove: true` removes it.
import { randomUUID } from 'node:crypto'
import { gql } from './proxy.mjs'
import { normalizePhone } from './phone.mjs'
import { signAppToBots } from './signing.mjs'

export const CHATDADDY_IM_URL = 'https://api.chatdaddy.tech/im'
// ponytail: one amount in the shop's own currency, not converted; make it a manifest setting when a merchant asks
export const VIP_TOTAL_SPENT = 500
export const REPEAT_ORDERS = 2
export const BACKFILL_PAGES = 5 // x PAGE_SIZE = the 250 most recently updated customers
const PAGE_SIZE = 50

export const FIELD_NAMES = [
	'shopify total spent', 'shopify order count', 'shopify last order date', 'shopify marketing consent',
]
export const TAG_NAMES = ['shopify-customer', 'shopify-vip', 'shopify-repeat']
export const OWNED = [...FIELD_NAMES, ...TAG_NAMES]

const str = v => (v === undefined || v === null ? '' : `${v}`.trim())

/** @returns {{ contact: object } | { skip: string }} contact = one `contacts[]` item of POST /contacts/upsert */
export function customerToContact(c) {
	if(!c || typeof c !== 'object') {
		return { skip: 'no customer' }
	}

	const addr = c.default_address
	const phone = [[c.phone, addr?.country_code], [addr?.phone, addr?.country_code]]
		.map(([p, cc]) => normalizePhone(p, cc)).find(Boolean)
	if(!phone) {
		return { skip: 'no usable phone number' }
	}

	const spent = Number(c.total_spent)
	const orders = Number(c.orders_count)
	const tags = [{ name: 'shopify-customer' }]
	if(spent >= VIP_TOTAL_SPENT) {
		tags.push({ name: 'shopify-vip' })
	}

	if(orders >= REPEAT_ORDERS) {
		tags.push({ name: 'shopify-repeat' })
	}

	const field = (name, value) => (str(value) ? [{ name, value: str(value).slice(0, 255) }] : [])
	return {
		contact: {
			name: [str(c.first_name), str(c.last_name)].filter(Boolean).join(' ') || null,
			phoneNumber: phone,
			...(str(c.email) ? { email: str(c.email) } : {}),
			tags: [
				...tags,
				...field('shopify total spent', Number.isFinite(spent) ? c.total_spent : ''),
				...field('shopify order count', Number.isFinite(orders) ? orders : ''),
				...field('shopify last order date', c.last_order_date),
				...field('shopify marketing consent', Boolean(c.accepts_marketing || c.sms_marketing_consent?.state === 'subscribed')),
			],
		},
	}
}

const CUSTOMER_FIELDS = `
	legacyResourceId firstName lastName email phone updatedAt
	defaultAddress { phone countryCodeV2 }
	amountSpent { amount } numberOfOrders
	lastOrder { processedAt }
	emailMarketingConsent { marketingState } smsMarketingConsent { marketingState }`

/** Admin GraphQL Customer -> the REST-webhook shape customerToContact reads */
export const fromGraphql = n => ({
	first_name: n.firstName, last_name: n.lastName, email: n.email, phone: n.phone,
	default_address: n.defaultAddress && { phone: n.defaultAddress.phone, country_code: n.defaultAddress.countryCodeV2 },
	total_spent: n.amountSpent?.amount, orders_count: Number(n.numberOfOrders),
	last_order_date: n.lastOrder?.processedAt,
	accepts_marketing: n.smsMarketingConsent?.marketingState === 'SUBSCRIBED' || n.emailMarketingConsent?.marketingState === 'SUBSCRIBED',
})

/** the webhook body lacks the last order's date: one best-effort lookup for it */
export async function withLastOrderDate(proxy, installationId, customer) {
	if(!/^\d{1,20}$/.test(`${customer?.id}`)) {
		return customer
	}

	const data = await gql(proxy, installationId, 'query($id: ID!) { customer(id: $id) { lastOrder { processedAt } } }',
		{ id: `gid://shopify/Customer/${customer.id}` })
	return { ...customer, last_order_date: data.customer?.lastOrder?.processedAt }
}

/** the most recently updated customers (BACKFILL_PAGES x 50), as webhook-shaped customers */
export async function recentCustomers(proxy, installationId) {
	const out = []
	let after = null
	for(let page = 0; page < BACKFILL_PAGES; page++) {
		const { customers } = await gql(proxy, installationId, `query($after: String) {
			customers(first: ${PAGE_SIZE}, after: $after, sortKey: UPDATED_AT, reverse: true) {
				nodes { ${CUSTOMER_FIELDS} } pageInfo { hasNextPage endCursor }
			} }`, { after })
		out.push(...(customers?.nodes || []).map(fromGraphql))
		if(!customers?.pageInfo?.hasNextPage) {
			break
		}

		after = customers.pageInfo.endCursor
	}

	return out
}

export class ContactsError extends Error {}

/** ChatDaddy im contacts API with a per-call app token. The token is only ever put in the Authorization header. */
export function createContactsClient({ fetch: doFetch = fetch, baseUrl = CHATDADDY_IM_URL } = {}) {
	const call = async(token, method, path, body) => {
		const res = await doFetch(baseUrl + path, {
			method, redirect: 'error', signal: AbortSignal.timeout(15_000),
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		if(res.status < 200 || res.status >= 300) {
			throw new ContactsError(`contacts api responded ${res.status}`)
		}

		return res.json().catch(() => ({}))
	}

	return {
		/** POST /contacts/upsert (CONTACTS_CREATE), up to 15000 per call; chunked at 500 */
		async upsert(token, contacts) {
			for(let i = 0; i < contacts.length; i += 500) {
				await call(token, 'POST', '/contacts/upsert', { contacts: contacts.slice(i, i + 500) })
			}
		},
		/** GET /contacts?q= (CONTACTS_READ_ALL): contact ids matching a phone or email */
		async findIds(token, q) {
			const res = await call(token, 'GET', `/contacts?q=${encodeURIComponent(q)}&count=20`)
			return (res.contacts || []).map(c => c.id)
		},
		/** PATCH /contacts (CONTACTS_UPDATE): ponytail: repeated `contacts=` for the deepObject array is unverified */
		patchTags(token, ids, tags) {
			const qs = ids.map(id => `contacts=${encodeURIComponent(id)}`).join('&')
			return call(token, 'PATCH', `/contacts?${qs}`, { patch: { tags } })
		},
	}
}

/** customers/redact: strip every field and tag this app wrote from the customer's contact(s). Returns how many contacts. */
export async function redactCustomer(contacts, token, customer) {
	const phone = normalizePhone(customer?.phone, customer?.default_address?.country_code)
	const q = phone || str(customer?.email)
	if(!q) {
		return 0
	}

	const ids = await contacts.findIds(token, q)
	if(ids.length) {
		await contacts.patchTags(token, ids, OWNED.map(name => ({ name, remove: true })))
	}

	return ids.length
}

export class TokenError extends Error {
	constructor(status) {
		super(`app token route responded ${status}`)
		this.status = status
	}
}

const FALLBACK_TTL_MS = 240_000 // the route omits expiresAt when it cannot read it; tokens live 5 minutes

/**
 * getAppToken(installationId): POST {botsUrl}/app-installations/{id}/token (bots #396), signed like a
 * trigger delivery (app-to-bots, fresh event id). Cached per installation until expiresAt - 60 s;
 * concurrent callers share one request. Throws TokenError(status) on non-2xx. The token is never logged.
 */
export function createTokenProvider({ store, botsUrl, fetch: doFetch = fetch, nowMs = Date.now }) {
	const cache = new Map() // installationId -> { token, until }
	const inflight = new Map()
	const request = async installationId => {
		const secret = store.currentSecret(installationId)
		if(!secret) {
			throw new TokenError(0)
		}

		const eventId = randomUUID()
		const body = JSON.stringify({ purpose: 'app-token', installationId })
		const res = await doFetch(`${botsUrl.replace(/\/+$/, '')}/app-installations/${installationId}/token`, {
			method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body,
			headers: {
				'content-type': 'application/json',
				'x-chatdaddy-event-id': eventId,
				'x-chatdaddy-signature': signAppToBots(secret, eventId, body, Math.floor(nowMs() / 1000)),
			},
		})
		if(res.status < 200 || res.status >= 300) {
			throw new TokenError(res.status)
		}

		const { accessToken, expiresAt } = await res.json()
		if(typeof accessToken !== 'string' || !accessToken) {
			throw new TokenError(res.status)
		}

		const exp = Date.parse(expiresAt)
		cache.set(installationId, { token: accessToken, until: (Number.isFinite(exp) ? exp : nowMs() + FALLBACK_TTL_MS) - 60_000 })
		return accessToken
	}

	return installationId => {
		const hit = cache.get(installationId)
		if(hit && hit.until > nowMs()) {
			return Promise.resolve(hit.token)
		}

		if(!inflight.has(installationId)) {
			inflight.set(installationId, request(installationId).finally(() => inflight.delete(installationId)))
		}

		return inflight.get(installationId)
	}
}
