// validateManifest: the same two layers ChatDaddy runs when a manifest is published.
//  1. the JSON Schema (schema.mjs, run by engine.mjs): shapes, required fields, https
//  2. semantic checks a schema cannot express: scope names that exist and are
//     app-grantable, event names that exist, unique ids inside each array, and no
//     private/loopback hosts.
// Both layers always run and their errors are combined.
import { readFileSync } from 'node:fs'
import { validate } from './engine.mjs'
import { isPrivateOrLoopbackHost } from './hosts.mjs'
import { APP_MANIFEST_SCHEMA } from './schema.mjs'

const load = name => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url), 'utf8'))
const scopes = load('scopes')
const KNOWN_SCOPES = new Set(scopes.known)
// The only scopes an app may ever hold: those marked appGrantable in the scope
// catalogue. Everything else (deletes, team/settings/billing, tokens, webhooks, channel
// management, admin) is refused whatever the manifest asks for.
const APP_GRANTABLE_SCOPES = new Set(scopes.appGrantable)
const KNOWN_EVENT_NAMES = new Set(load('events').events)

/** where the scope and event snapshots came from, for `validate` to print */
export const CATALOGUE_SOURCE = { scopes: scopes.source, events: load('events').source }

const isObj = v => v !== null && typeof v === 'object'
const strings = arr => arr.filter(v => typeof v === 'string')

function pushDuplicates(errors, path, values, label) {
	const seen = new Set()
	for(const value of values) {
		if(seen.has(value)) {
			errors.push({ path, message: `${path}: duplicate ${label} "${value}"` })
		}

		seen.add(value)
	}
}

/**
 * @param {unknown} manifest
 * @returns {{ valid: boolean, errors: { path: string, message: string }[] }}
 */
export function validateManifest(manifest) {
	const errors = validate(APP_MANIFEST_SCHEMA, manifest)
	const schemaValid = errors.length === 0

	// the semantic checks need a roughly-shaped object; the schema errors already say why
	if(!manifest || typeof manifest !== 'object') {
		return { valid: false, errors }
	}

	const m = manifest

	// --- scopes: must be known scope keys that apps may hold, and unique ---
	if(Array.isArray(m.scopes)) {
		for(const scope of m.scopes) {
			if(typeof scope === 'string' && !KNOWN_SCOPES.has(scope)) {
				errors.push({ path: '/scopes', message: `/scopes: unknown scope "${scope}" (not a key of SCOPES in @chatdaddy/client)` })
			} else if(typeof scope === 'string' && !APP_GRANTABLE_SCOPES.has(scope)) {
				errors.push({ path: '/scopes', message: `/scopes: "${scope}" cannot be granted to an app` })
			}
		}

		pushDuplicates(errors, '/scopes', strings(m.scopes), 'scope')
	}

	// --- https-only + no private/loopback host, for every URL/host field ---
	const urlChecks = [
		{ path: '/privacyPolicyUrl', value: m.privacyPolicyUrl },
		{ path: '/developer/url', value: m.developer?.url },
	]
	if(m.handler?.type === 'url') {
		urlChecks.push({ path: '/handler/baseUrl', value: m.handler.baseUrl })
	}

	const asArray = v => (Array.isArray(v) ? v : [])
	const items = v => asArray(v).filter(isObj)
	for(const [i, connection] of asArray(m.connections).entries()) {
		if(!isObj(connection)) {
			continue
		}

		urlChecks.push({ path: `/connections/${i}/authUrl`, value: connection.authUrl })
		urlChecks.push({ path: `/connections/${i}/tokenUrl`, value: connection.tokenUrl })
		for(const [j, host] of asArray(connection.hosts).entries()) {
			urlChecks.push({ path: `/connections/${i}/hosts/${j}`, value: host })
		}
	}

	for(const { path, value } of urlChecks) {
		if(typeof value !== 'string' || !value) {
			continue
		}

		if(isPrivateOrLoopbackHost(value)) {
			errors.push({ path, message: `${path}: private/loopback hosts are not allowed ("${value}")` })
		}
	}

	// --- unique ids within each array ---
	const ids = (arr, key) => items(arr).map(x => x[key]).filter(Boolean)
	if(Array.isArray(m.connections)) {
		pushDuplicates(errors, '/connections', ids(m.connections, 'id'), 'connection id')
	}

	if(Array.isArray(m.flowActions)) {
		pushDuplicates(errors, '/flowActions', ids(m.flowActions, 'id'), 'flowAction id')
	}

	if(Array.isArray(m.flowTriggers)) {
		pushDuplicates(errors, '/flowTriggers', ids(m.flowTriggers, 'id'), 'flowTrigger id')
	}

	if(Array.isArray(m.templates)) {
		pushDuplicates(errors, '/templates', ids(m.templates, 'id'), 'template id')
	}

	if(Array.isArray(m.settings)) {
		pushDuplicates(errors, '/settings', ids(m.settings, 'propertyPath'), 'setting propertyPath')
	}

	for(const [i, action] of asArray(m.flowActions).entries()) {
		if(!isObj(action)) {
			continue
		}

		if(Array.isArray(action.inputProperties)) {
			pushDuplicates(errors, `/flowActions/${i}/inputProperties`, ids(action.inputProperties, 'propertyPath'), 'inputProperties propertyPath')
		}

		if(Array.isArray(action.outputProperties)) {
			pushDuplicates(errors, `/flowActions/${i}/outputProperties`, ids(action.outputProperties, 'propertyPath'), 'outputProperties propertyPath')
		}
	}

	// --- eventSubscriptions: must reference real event names, and be unique ---
	if(Array.isArray(m.eventSubscriptions)) {
		for(const event of m.eventSubscriptions) {
			if(typeof event === 'string' && !KNOWN_EVENT_NAMES.has(event)) {
				errors.push({ path: '/eventSubscriptions', message: `/eventSubscriptions: unknown event "${event}" (not a value of EventName in @chatdaddy/client)` })
			}
		}

		pushDuplicates(errors, '/eventSubscriptions', strings(m.eventSubscriptions), 'event')
	}

	return { valid: schemaValid && errors.length === 0, errors }
}
