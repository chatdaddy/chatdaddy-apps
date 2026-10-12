// `connected` (the merchant finished Log in with Shopify) and uninstall: register / remove this
// installation's webhook subscriptions through the connection proxy, one GraphQL request each.
import { ProxyError, gql } from './proxy.mjs'
import { TOPIC_TRIGGERS } from './shopify.mjs'

const toEnum = topic => topic.toUpperCase().replace('/', '_') // orders/create -> ORDERS_CREATE

// Filtered by our own callback URL (one per installation) and the app only ever subscribes to
// the TOPIC_TRIGGERS topics, so this list holds at most 5 rows: no pagination needed. Asserted
// below via hasNextPage, so a surprise fails loudly instead of silently creating duplicates.
const LIST = `query($url: URL!) {
	webhookSubscriptions(first: 50, callbackUrl: $url) {
		nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } }
		pageInfo { hasNextPage }
	}
}`

/**
 * Idempotent: a topic already pointing at our callback URL is reused, not created twice, so a
 * repeated `connected` is safe. All missing topics are created in ONE request (aliased
 * mutations; every value is a GraphQL variable). Returns [{ topic, id }] and records them.
 */
export async function registerWebhooks({ proxy, store, installationId, publicUrl }) {
	const callbackUrl = `${publicUrl.replace(/\/+$/, '')}/shopify/webhook/${installationId}`
	const listed = (await gql(proxy, installationId, LIST, { url: callbackUrl })).webhookSubscriptions
	if(listed?.pageInfo?.hasNextPage) {
		throw new ProxyError('more webhook subscriptions than this app can have; refusing to guess')
	}

	const existing = listed?.nodes || []
	const subs = []
	const missing = []
	for(const topic of Object.keys(TOPIC_TRIGGERS)) {
		const have = existing.find(w => w.topic === toEnum(topic) && w.endpoint?.callbackUrl === callbackUrl)
		if(have) {
			subs.push({ topic, id: have.id })
		} else {
			missing.push(topic)
		}
	}

	if(missing.length) {
		const decls = missing.map((_, i) => `$t${i}: WebhookSubscriptionTopic!, $s${i}: WebhookSubscriptionInput!`).join(', ')
		const calls = missing.map((_, i) => `a${i}: webhookSubscriptionCreate(topic: $t${i}, webhookSubscription: $s${i}) {
			webhookSubscription { id } userErrors { message } }`).join('\n')
		const variables = {}
		missing.forEach((topic, i) => {
			variables[`t${i}`] = toEnum(topic)
			variables[`s${i}`] = { callbackUrl, format: 'JSON' }
		})
		const data = await gql(proxy, installationId, `mutation(${decls}) { ${calls} }`, variables)
		missing.forEach((topic, i) => {
			const res = data[`a${i}`]
			const id = res?.webhookSubscription?.id
			if(!id) {
				throw new ProxyError(`webhook ${topic} not created: ${(res?.userErrors || []).map(e => e.message).join('; ').slice(0, 200)}`)
			}

			subs.push({ topic, id })
		})
	}

	store.saveWebhooks(installationId, subs)
	return subs
}

/** best effort, one request: on uninstall the connection may already be gone, so a failure is only logged */
export async function removeWebhooks({ proxy, store, installationId, log = () => {} }) {
	const hooks = store.webhooksFor(installationId)
	if(!hooks.length) {
		return
	}

	const decls = hooks.map((_, i) => `$id${i}: ID!`).join(', ')
	const calls = hooks.map((_, i) => `d${i}: webhookSubscriptionDelete(id: $id${i}) { userErrors { message } }`).join('\n')
	const variables = Object.fromEntries(hooks.map((h, i) => [`id${i}`, h.id]))
	try {
		await gql(proxy, installationId, `mutation(${decls}) { ${calls} }`, variables)
	} catch(err) {
		log({ msg: 'webhook removal failed', installationId, reason: `${err.message}`.slice(0, 200) })
	}
}
