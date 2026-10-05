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
			// the oauth2 endpoints' hosts must be listed exactly
			hosts: ['shopify.com', 'api.shopify.com'],
		},
		{
			id: 'acme-api',
			provider: 'acme',
			type: 'apiKey',
			scopes: [],
			// one exact host, plus one template filled from the admin's connect-time input
			hosts: ['api.acme.com', '{tenant}.acme-cloud.com'],
			inputs: [{ id: 'tenant', label: 'Account subdomain', pattern: '^[a-z0-9-]+$' }],
			headerName: 'X-Acme-Token',
			forwardHeaders: ['X-Acme-Version', 'Idempotency-Key'],
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

/**
 * Connection shapes that must validate, each merged into the minimal manifest as its only
 * connection. Ported one-to-one from ChatDaddy's validator fixtures.
 */
export const validConnectionVariants = [
	{
		name: 'apiKey without authUrl/tokenUrl, Authorization with a Bearer prefix',
		connection: {
			id: 'bearer-api',
			provider: 'acme',
			type: 'apiKey',
			scopes: [],
			hosts: ['api.acme.com'],
			headerName: 'Authorization',
			headerPrefix: 'Bearer ',
		},
	},
	{
		name: 'apiKey with a header name in unusual case and three inputs',
		connection: {
			id: 'three-inputs',
			provider: 'acme',
			type: 'apiKey',
			scopes: [],
			hosts: ['{region}.acme-cloud.com'],
			inputs: [
				{ id: 'region', label: 'Region' },
				{ id: 'account', label: 'Account' },
				{ id: 'env', label: 'Environment' },
			],
			headerName: 'x-acme-key',
		},
	},
	{
		name: 'oauth2 whose auth and token hosts are exact hosts, next to a template',
		connection: {
			id: 'oauth-tpl',
			provider: 'acme',
			type: 'oauth2',
			authUrl: 'https://login.acme.com/authorize',
			tokenUrl: 'https://login.acme.com/token',
			scopes: ['read'],
			hosts: ['login.acme.com', '{tenant}.acme-cloud.com'],
			inputs: [{ id: 'tenant', label: 'Tenant' }],
			forwardHeaders: ['accept-language'],
		},
	},
	{
		name: 'oauth2 host comparison normalises the endpoint URL case and trailing dot',
		connection: {
			id: 'oauth-case',
			provider: 'acme',
			type: 'oauth2',
			authUrl: 'https://LOGIN.acme.com./authorize',
			tokenUrl: 'https://login.acme.com/token',
			scopes: [],
			hosts: ['login.acme.com'],
		},
	},
]

const full = validFullManifest
const act0 = full.flowActions[0]
const apiKey = full.connections[1]
const oauth = full.connections[0]
const withConnection = connection => ({ ...full, connections: [connection] })
const tpl = host => withConnection({ ...apiKey, hosts: [host] })

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

	// ---- connections: inputs ----
	{ rule: 'connection input id is not a slug', manifest: withConnection({ ...apiKey, inputs: [{ id: 'Not Slug', label: 'x' }] }), expect: '/connections/0/inputs/0/id' },
	{ rule: 'connection input needs a label', manifest: withConnection({ ...apiKey, inputs: [{ id: 'tenant' }] }), expect: "required property 'label'" },
	{ rule: 'connection has at most 3 inputs', manifest: withConnection({ ...apiKey, inputs: ['a', 'b', 'c', 'tenant'].map(id => ({ id, label: id })) }), expect: 'more than 3 items' },
	{ rule: 'duplicate connection input id', manifest: withConnection({ ...apiKey, inputs: [apiKey.inputs[0], apiKey.inputs[0]] }), expect: 'duplicate input id' },
	{ rule: 'connection input pattern must compile', manifest: withConnection({ ...apiKey, inputs: [{ id: 'tenant', label: 'x', pattern: '(' }] }), expect: 'does not compile' },
	{ rule: 'connection input pattern over 200 characters', manifest: withConnection({ ...apiKey, inputs: [{ id: 'tenant', label: 'x', pattern: 'a'.repeat(201) }] }), expect: '/inputs/0/pattern' },
	{ rule: 'connection hosts must not be empty', manifest: withConnection({ ...apiKey, hosts: [] }), expect: 'fewer than 1 items' },
	// ---- connections: host templates ----
	{ rule: 'host template placeholder must name a declared input', manifest: tpl('{shop}.acme-cloud.com'), expect: 'does not name a declared input' },
	{ rule: 'host template placeholder must be the whole leftmost label', manifest: tpl('x{tenant}.acme-cloud.com'), expect: 'malformed host template' },
	{ rule: 'host template must be the leftmost label', manifest: tpl('api.{tenant}.acme-cloud.com'), expect: 'malformed host template' },
	{ rule: 'host template placeholder must be closed', manifest: tpl('{tenant.acme-cloud.com'), expect: 'malformed host template' },
	{ rule: 'host template has a single placeholder', manifest: tpl('{tenant}.{tenant}.acme-cloud.com'), expect: 'malformed host template' },
	{ rule: 'at most one host template per connection', manifest: withConnection({ ...apiKey, hosts: ['{tenant}.acme-cloud.com', '{tenant}.acme-eu.com'] }), expect: 'at most one host template' },
	{ rule: 'host template suffix needs two labels', manifest: tpl('{tenant}.com'), expect: 'at least two labels' },
	{ rule: 'host template suffix may not be a public suffix (ICANN)', manifest: tpl('{tenant}.co.uk'), expect: 'must not be a public suffix' },
	{ rule: 'host template suffix may not be a public suffix (private section: github.io)', manifest: tpl('{tenant}.github.io'), expect: 'must not be a public suffix' },
	{ rule: 'host template suffix may not be a public suffix (private section: vercel.app)', manifest: tpl('{tenant}.vercel.app'), expect: 'must not be a public suffix' },
	{ rule: 'host template suffix may not be a public suffix (wildcard rule: *.ck)', manifest: tpl('{tenant}.foo.ck'), expect: 'must not be a public suffix' },
	{ rule: 'host template suffix must be lower case', manifest: tpl('{tenant}.Acme-Cloud.com'), expect: 'lowercase ASCII' },
	{ rule: 'host template suffix must be ASCII', manifest: tpl('{tenant}.acme-cl\u00f6ud.com'), expect: 'lowercase ASCII' },
	{ rule: 'host template suffix has no trailing dot', manifest: tpl('{tenant}.acme-cloud.com.'), expect: 'must not end with a dot' },
	{ rule: 'host template suffix may not contain empty labels', manifest: tpl('{tenant}.acme..com'), expect: 'lowercase ASCII' },
	{ rule: 'host template suffix may not be private/loopback', manifest: tpl('{tenant}.corp.local'), expect: 'private/loopback' },
	// ---- connections: apiKey / oauth2 field requirements ----
	{ rule: 'apiKey connection requires headerName', manifest: withConnection({ ...apiKey, headerName: undefined }), expect: "required property 'headerName'" },
	{ rule: 'oauth2 connection requires authUrl', manifest: withConnection({ ...oauth, authUrl: undefined }), expect: "required property 'authUrl'" },
	{ rule: 'oauth2 connection requires tokenUrl', manifest: withConnection({ ...oauth, tokenUrl: undefined }), expect: "required property 'tokenUrl'" },
	{ rule: 'apiKey authUrl, if given, must still be https', manifest: withConnection({ ...apiKey, authUrl: 'http://api.acme.com/a' }), expect: '/connections/0/authUrl' },
	// ---- connections: oauth2 host tie ----
	{ rule: 'oauth2 authUrl host must be in hosts', manifest: withConnection({ ...oauth, hosts: ['api.shopify.com'] }), expect: '/connections/0/authUrl' },
	{ rule: 'oauth2 tokenUrl host must be in hosts', manifest: withConnection({ ...oauth, hosts: ['shopify.com'], tokenUrl: 'https://auth.shopify.com/token' }), expect: '/connections/0/tokenUrl' },
	{
		rule: 'oauth2 tokenUrl host matching only the host template does not count',
		manifest: withConnection({ ...oauth, hosts: ['shopify.com', '{tenant}.acme-cloud.com'], inputs: [{ id: 'tenant', label: 'x' }], tokenUrl: 'https://eu.acme-cloud.com/token' }),
		expect: 'a host template does not count',
	},
	// ---- connections: header floor ----
	{ rule: 'headerName may not be a denied header (Host)', manifest: withConnection({ ...apiKey, headerName: 'Host' }), expect: 'header "Host" is not allowed' },
	{ rule: 'headerName denylist is case-insensitive (CoOkIe)', manifest: withConnection({ ...apiKey, headerName: 'CoOkIe' }), expect: 'is not allowed' },
	{ rule: 'headerName may not be proxy-*', manifest: withConnection({ ...apiKey, headerName: 'Proxy-Authorization' }), expect: 'is not allowed' },
	{ rule: 'headerName may not be x-forwarded-*', manifest: withConnection({ ...apiKey, headerName: 'X-Forwarded-For' }), expect: 'is not allowed' },
	{ rule: 'headerName may not contain CR/LF', manifest: withConnection({ ...apiKey, headerName: 'X-A\r\nX-B' }), expect: 'not a valid header name' },
	{ rule: 'headerName may only use token characters', manifest: withConnection({ ...apiKey, headerName: 'X Token' }), expect: 'not a valid header name' },
	{ rule: 'headerPrefix may not contain CR/LF', manifest: withConnection({ ...apiKey, headerPrefix: 'Bearer \r\nX-Evil: 1' }), expect: '/headerPrefix' },
	{ rule: 'forwardHeaders may not hold a denied header (Transfer-Encoding)', manifest: withConnection({ ...apiKey, forwardHeaders: ['x-ok', 'Transfer-Encoding'] }), expect: '/connections/0/forwardHeaders/1' },
	{ rule: 'forwardHeaders may not hold authorization', manifest: withConnection({ ...apiKey, forwardHeaders: ['Authorization'] }), expect: 'only allowed as the connection' },
	{ rule: 'forwardHeaders may not contain CR/LF', manifest: withConnection({ ...apiKey, forwardHeaders: ['X-A\nB'] }), expect: 'not a valid header name' },
	{ rule: 'forwardHeaders entries are unique case-insensitively', manifest: withConnection({ ...apiKey, forwardHeaders: ['X-Foo', 'x-foo'] }), expect: 'duplicate forwardHeaders' },
]
