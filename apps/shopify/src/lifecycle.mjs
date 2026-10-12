// `connected` (the merchant finished Log in with Shopify) and uninstall: register / remove this
// installation's webhook subscriptions through the connection proxy.
import { gql } from './proxy.mjs'
import { TOPIC_TRIGGERS } from './shopify.mjs'

const toEnum = topic => topic.toUpperCase().replace('/', '_') // orders/create -> ORDERS_CREATE

const LIST = `query { webhookSubscriptions(first: 100) { nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } } }`
const CREATE = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
	webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { message } }
}`
const DELETE = `mutation($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { message } } }`

/**
 * Idempotent: a topic already pointing at our callback URL is reused, not created twice, so a
 * repeated `connected` is safe. Returns [{ topic, id }] and records them in the store.
 */
export async function registerWebhooks({ proxy, store, installationId, publicUrl }) {
	const callbackUrl = `${publicUrl.replace(/\/+$/, '')}/shopify/webhook/${installationId}`
	const existing = (await gql(proxy, installationId, LIST)).webhookSubscriptions?.nodes || []
	const subs = []
	for(const topic of Object.keys(TOPIC_TRIGGERS)) {
		const have = existing.find(w => w.topic === toEnum(topic) && w.endpoint?.callbackUrl === callbackUrl)
		if(have) {
			subs.push({ topic, id: have.id })
			continue
		}

		const res = (await gql(proxy, installationId, CREATE, { topic: toEnum(topic), sub: { callbackUrl, format: 'JSON' } }))
			.webhookSubscriptionCreate
		const id = res?.webhookSubscription?.id
		if(!id) {
			throw new Error(`webhook ${topic} not created: ${(res?.userErrors || []).map(e => e.message).join('; ').slice(0, 200)}`)
		}

		subs.push({ topic, id })
	}

	store.saveWebhooks(installationId, subs)
	return subs
}

/** best effort: on uninstall the connection may already be gone, so a failure is only logged */
export async function removeWebhooks({ proxy, store, installationId, log = () => {} }) {
	for(const w of store.webhooksFor(installationId)) {
		try {
			await gql(proxy, installationId, DELETE, { id: w.id })
		} catch(err) {
			log({ msg: 'webhook removal failed', installationId, topic: w.topic, reason: err.message })
		}
	}
}
