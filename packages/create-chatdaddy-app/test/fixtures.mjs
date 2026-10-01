// Manifest fixtures ported one-to-one from ChatDaddy's publish-time validator tests:
// two valid manifests, and one invalid manifest per validation rule. Each invalid
// case must produce at least one error whose path or message contains `expect`.

export const validMinimalManifest = {
	manifestVersion: 1,
	id: 'hello-world',
	name: 'Hello World',
	description: 'The smallest manifest that passes validation.',
	developer: { name: 'ChatDaddy', email: 'apps@chatdaddy.tech' },
	privacyPolicyUrl: 'https://chatdaddy.tech/privacy',
	scopes: ['CONTACTS_READ_ALL'],
	aiUse: 'none',
	handler: { type: 'hosted' },
}

export const validFullManifest = {
	manifestVersion: 1,
	id: 'shopify-orders',
	name: 'Shopify Orders',
	description: 'Sends a WhatsApp message when a Shopify order comes in, and lets flows look up order status.',
	developer: { name: 'ChatDaddy', email: 'apps@chatdaddy.tech', url: 'https://chatdaddy.tech' },
	privacyPolicyUrl: 'https://chatdaddy.tech/privacy',
	scopes: ['CONTACTS_READ_ALL', 'MESSAGES_SEND_TO_ALL'],
	aiUse: 'none',
	handler: { type: 'hosted' },
	connections: [
		{
			id: 'shopify-store',
			provider: 'shopify',
			type: 'oauth2',
			authUrl: 'https://shopify.com/oauth/authorize',
			tokenUrl: 'https://shopify.com/oauth/token',
			scopes: ['read_orders'],
			hosts: ['api.shopify.com'],
		},
	],
	settings: [
		{ propertyPath: 'storeName', title: 'Store name', description: 'Your Shopify store subdomain', type: 'string', required: true },
	],
	flowActions: [
		{
			id: 'get-order-status',
			title: 'Get order status',
			description: 'Look up the status of a Shopify order by id',
			inputProperties: [{ propertyPath: 'orderId', title: 'Order ID', type: 'string', required: true }],
			outputProperties: [
				{ propertyPath: 'status', title: 'Status', type: 'string', required: true },
				{ propertyPath: 'tags', title: 'Tags', type: 'array', required: false, items: { type: 'string' } },
			],
		},
	],
	flowTriggers: [
		{
			id: 'order-created',
			title: 'Order created',
			description: 'Fires when a new Shopify order is created',
			payloadSchema: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } },
		},
	],
	templates: [
		{ id: 'order-confirmation-flow', name: 'Order confirmation flow', description: 'Sends a WhatsApp confirmation when an order comes in' },
	],
	eventSubscriptions: ['contact-insert'],
}

const full = validFullManifest
const act0 = full.flowActions[0]

export const invalidManifestFixtures = [
	{ rule: 'missing required field (name)', manifest: { ...full, name: undefined }, expect: 'name' },
	{ rule: 'id is not a slug', manifest: { ...full, id: 'Not A Slug!' }, expect: '/id' },
	{ rule: 'manifestVersion must be 1', manifest: { ...full, manifestVersion: 2 }, expect: 'manifestVersion' },
	{ rule: 'unknown scope', manifest: { ...full, scopes: ['NOT_A_REAL_SCOPE'] }, expect: 'unknown scope' },
	{ rule: 'at least one scope', manifest: { ...full, scopes: [] }, expect: '/scopes' },
	{ rule: 'duplicate scope', manifest: { ...full, scopes: ['CONTACTS_READ_ALL', 'CONTACTS_READ_ALL'] }, expect: 'duplicate scope' },
	{ rule: 'aiUse must be none|task-bound', manifest: { ...full, aiUse: 'always' }, expect: 'aiUse' },
	{ rule: 'handler url type requires baseUrl', manifest: { ...full, handler: { type: 'url' } }, expect: '/handler' },
	{ rule: 'handler baseUrl must be https', manifest: { ...full, handler: { type: 'url', baseUrl: 'http://example.com' } }, expect: '/handler/baseUrl' },
	{ rule: 'privacyPolicyUrl must be https', manifest: { ...full, privacyPolicyUrl: 'http://chatdaddy.tech/privacy' }, expect: '/privacyPolicyUrl' },
	{ rule: 'developer.url must be https', manifest: { ...full, developer: { ...full.developer, url: 'http://chatdaddy.tech' } }, expect: '/developer/url' },
	{ rule: 'handler baseUrl must not be a private/loopback host', manifest: { ...full, handler: { type: 'url', baseUrl: 'https://localhost:4000' } }, expect: 'private/loopback' },
	{ rule: 'connection host must not be private/loopback', manifest: { ...full, connections: [{ ...full.connections[0], hosts: ['192.168.1.5'] }] }, expect: 'private/loopback' },
	{ rule: 'connection authUrl must not be private/loopback', manifest: { ...full, connections: [{ ...full.connections[0], authUrl: 'https://127.0.0.1/oauth/authorize' }] }, expect: 'private/loopback' },
	{ rule: 'duplicate connection id', manifest: { ...full, connections: [full.connections[0], full.connections[0]] }, expect: 'duplicate connection id' },
	{ rule: 'duplicate flowAction id', manifest: { ...full, flowActions: [act0, act0] }, expect: 'duplicate flowAction id' },
	{ rule: 'duplicate flowTrigger id', manifest: { ...full, flowTriggers: [full.flowTriggers[0], full.flowTriggers[0]] }, expect: 'duplicate flowTrigger id' },
	{ rule: 'duplicate template id', manifest: { ...full, templates: [full.templates[0], full.templates[0]] }, expect: 'duplicate template id' },
	{ rule: 'duplicate settings propertyPath', manifest: { ...full, settings: [full.settings[0], full.settings[0]] }, expect: 'duplicate setting propertyPath' },
	{
		rule: 'duplicate inputProperties propertyPath within an action',
		manifest: { ...full, flowActions: [{ ...act0, inputProperties: [act0.inputProperties[0], act0.inputProperties[0]] }] },
		expect: 'duplicate inputProperties propertyPath',
	},
	{ rule: 'unknown eventSubscription', manifest: { ...full, eventSubscriptions: ['not-a-real-event'] }, expect: 'unknown event' },
	{
		rule: 'array-type property missing items',
		manifest: { ...full, settings: [{ propertyPath: 'tags', title: 'Tags', type: 'array' }] },
		expect: '/settings',
	},
	{ rule: 'additional properties are rejected', manifest: { ...full, notAField: true }, expect: '(root)' },
]
