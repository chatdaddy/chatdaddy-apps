// The App Store manifest JSON Schema (draft-07), schema v1: structure only. Ported
// from ChatDaddy's validator; engine.mjs implements exactly the
// keywords used here (see KEYWORDS in engine.mjs). Checks that need data outside
// the manifest (scope and event names, cross-field uniqueness, private hosts) are in
// manifest.mjs.

const idPattern = '^[a-z0-9]+(-[a-z0-9]+)*$'

const propertyOption = {
	type: 'object',
	additionalProperties: false,
	required: ['label', 'valueStr'],
	properties: {
		label: { type: 'string', minLength: 1, maxLength: 64 },
		valueStr: { type: 'string', minLength: 1, maxLength: 64 },
	},
}

// The element descriptor under an array-typed property's `items`: a property
// descriptor without `propertyPath`/`title`.
const propertyItems = {
	type: 'object',
	additionalProperties: false,
	required: ['type'],
	properties: {
		type: { type: 'string', enum: ['string', 'number', 'boolean', 'array'] },
		description: { type: 'string', maxLength: 200 },
		required: { type: 'boolean' },
		options: { type: 'array', items: propertyOption },
		items: { $ref: '#/definitions/propertyItems' },
	},
}

const propertyDescriptor = {
	type: 'object',
	additionalProperties: false,
	required: ['propertyPath', 'title', 'type'],
	properties: {
		propertyPath: { type: 'string', minLength: 1, maxLength: 64 },
		title: { type: 'string', minLength: 1, maxLength: 64 },
		description: { type: 'string', maxLength: 200 },
		type: { type: 'string', enum: ['string', 'number', 'boolean', 'array'] },
		required: { type: 'boolean' },
		options: { type: 'array', items: propertyOption },
		items: { $ref: '#/definitions/propertyItems' },
	},
	// items is required when type === 'array'
	allOf: [
		{
			if: { properties: { type: { const: 'array' } } },
			then: { required: ['items'] },
		},
	],
}

// https-only: `format: uri` only checks URL syntax, so `pattern` enforces the scheme.
// manifest.mjs additionally rejects private/loopback hosts.
const httpsUrl = {
	type: 'string',
	format: 'uri',
	pattern: '^https://',
	maxLength: 2048,
}

const appDeveloper = {
	type: 'object',
	additionalProperties: false,
	required: ['name', 'email'],
	properties: {
		name: { type: 'string', minLength: 1, maxLength: 128 },
		email: { type: 'string', format: 'email', maxLength: 256 },
		url: httpsUrl,
	},
}

const appHandler = {
	oneOf: [
		{
			type: 'object',
			additionalProperties: false,
			required: ['type'],
			properties: { type: { const: 'hosted' } },
		},
		{
			type: 'object',
			additionalProperties: false,
			required: ['type', 'baseUrl'],
			properties: { type: { const: 'url' }, baseUrl: httpsUrl },
		},
	],
}

const appConnection = {
	type: 'object',
	additionalProperties: false,
	required: ['id', 'provider', 'type', 'authUrl', 'tokenUrl', 'scopes', 'hosts'],
	properties: {
		id: { type: 'string', pattern: idPattern, maxLength: 64 },
		provider: { type: 'string', minLength: 1, maxLength: 64 },
		type: { type: 'string', enum: ['oauth2', 'apiKey'] },
		authUrl: httpsUrl,
		tokenUrl: httpsUrl,
		scopes: { type: 'array', items: { type: 'string', minLength: 1 } },
		hosts: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, maxLength: 256 } },
	},
}

const appFlowAction = {
	type: 'object',
	additionalProperties: false,
	required: ['id', 'title', 'inputProperties', 'outputProperties'],
	properties: {
		id: { type: 'string', pattern: idPattern, maxLength: 64 },
		title: { type: 'string', minLength: 1, maxLength: 128 },
		description: { type: 'string', maxLength: 500 },
		inputProperties: { type: 'array', items: propertyDescriptor },
		outputProperties: { type: 'array', items: propertyDescriptor },
	},
}

const appFlowTrigger = {
	type: 'object',
	additionalProperties: false,
	required: ['id', 'title', 'payloadSchema'],
	properties: {
		id: { type: 'string', pattern: idPattern, maxLength: 64 },
		title: { type: 'string', minLength: 1, maxLength: 128 },
		description: { type: 'string', maxLength: 500 },
		// an arbitrary JSON Schema; only required to be a plain object (it is not
		// meta-validated as JSON Schema)
		payloadSchema: { type: 'object' },
	},
}

const appTemplate = {
	type: 'object',
	additionalProperties: false,
	required: ['id', 'name'],
	properties: {
		id: { type: 'string', pattern: idPattern, maxLength: 64 },
		name: { type: 'string', minLength: 1, maxLength: 128 },
		description: { type: 'string', maxLength: 500 },
	},
}

export const APP_MANIFEST_SCHEMA = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	$id: 'https://chatdaddy.tech/schemas/app-manifest-v1.json',
	title: 'AppManifest',
	type: 'object',
	additionalProperties: false,
	required: [
		'manifestVersion', 'id', 'name', 'description', 'developer', 'privacyPolicyUrl', 'scopes', 'aiUse', 'handler',
	],
	properties: {
		manifestVersion: { const: 1 },
		id: { type: 'string', pattern: idPattern, minLength: 1, maxLength: 64 },
		name: { type: 'string', minLength: 1, maxLength: 128 },
		description: { type: 'string', minLength: 1, maxLength: 500 },
		developer: appDeveloper,
		privacyPolicyUrl: httpsUrl,
		// at least one: the app token is minted from the granted scopes, and auth
		// refuses an empty list (an empty list would otherwise mean every scope)
		scopes: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
		aiUse: { type: 'string', enum: ['none', 'task-bound'] },
		handler: appHandler,
		connections: { type: 'array', items: appConnection },
		settings: { type: 'array', items: propertyDescriptor },
		flowActions: { type: 'array', items: appFlowAction },
		flowTriggers: { type: 'array', items: appFlowTrigger },
		templates: { type: 'array', items: appTemplate },
		eventSubscriptions: { type: 'array', items: { type: 'string', minLength: 1 } },
	},
	definitions: { propertyItems },
}
