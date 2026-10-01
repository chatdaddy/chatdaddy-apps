// A small JSON Schema (draft-07) validator, dependency-free, implementing exactly the
// keywords ChatDaddy's manifest schema uses (so `validate` agrees with publish time)
// and nothing more. Error wording follows ajv, which ChatDaddy uses, because the
// fixtures and developers read it.
//
// Keywords implemented (KEYWORDS):
//   $ref (local "#/..." only)   type (string number boolean array object; also integer, null
//   and a list of types, for developers' own schemas)
//   const   enum   pattern (unicode flag, as ajv)   minLength   maxLength (code points)
//   minItems   required   properties   additionalProperties (false, or a schema)
//   items (single schema)   oneOf   allOf   if + then   format (uri, email)
// Annotations that are read and ignored (ANNOTATIONS): $schema $id title description
//   definitions default examples $comment.
// Anything else in a schema is NOT checked; unsupportedKeywords() lists it so a caller
// can say so instead of silently passing.
import { FORMATS } from './formats.mjs'

export const KEYWORDS = [
	'$ref', 'type', 'const', 'enum', 'pattern', 'minLength', 'maxLength', 'minItems', 'required',
	'properties', 'additionalProperties', 'items', 'oneOf', 'allOf', 'if', 'then', 'format',
]
export const ANNOTATIONS = ['$schema', '$id', 'title', 'description', 'definitions', 'default', 'examples', '$comment']

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const escapePointer = k => `${k}`.replace(/~/g, '~0').replace(/\//g, '~1')
const codePoints = s => [...s].length

function deepEqual(a, b) {
	if(a === b) {
		return true
	}

	if(Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
	}

	if(isPlainObject(a) && isPlainObject(b)) {
		const ka = Object.keys(a)
		return ka.length === Object.keys(b).length && ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]))
	}

	return false
}

const TYPE_CHECKS = {
	string: v => typeof v === 'string',
	number: v => typeof v === 'number' && Number.isFinite(v),
	boolean: v => typeof v === 'boolean',
	array: v => Array.isArray(v),
	object: isPlainObject,
	// not used by the manifest schema itself; they let a developer's own payloadSchema
	// (checked by `dev`) use the everyday JSON Schema types
	integer: v => Number.isInteger(v),
	null: v => v === null,
}

function resolveRef(ref, root) {
	if(!ref.startsWith('#/')) {
		throw new Error(`unsupported $ref "${ref}" (only local "#/..." references)`)
	}

	let node = root
	for(const part of ref.slice(2).split('/')) {
		node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
	}

	if(node === undefined) {
		throw new Error(`unresolvable $ref "${ref}"`)
	}

	return node
}

function check(schema, data, path, root, errors) {
	const fail = message => errors.push({ path: path || '/', message: `${path || '(root)'} ${message}` })

	if(schema.$ref !== undefined) {
		check(resolveRef(schema.$ref, root), data, path, root, errors)
	}

	if(schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type]
		if(!types.some(t => TYPE_CHECKS[t]?.(data))) {
			fail(`must be ${types.join(',')}`)
		}
	}

	if('const' in schema && !deepEqual(schema.const, data)) {
		fail('must be equal to constant')
	}

	if(schema.enum && !schema.enum.some(v => deepEqual(v, data))) {
		fail('must be equal to one of the allowed values')
	}

	if(typeof data === 'string') {
		if(schema.maxLength !== undefined && codePoints(data) > schema.maxLength) {
			fail(`must NOT have more than ${schema.maxLength} characters`)
		}

		if(schema.minLength !== undefined && codePoints(data) < schema.minLength) {
			fail(`must NOT have fewer than ${schema.minLength} characters`)
		}

		if(schema.pattern !== undefined && !patternMatches(schema.pattern, data)) {
			fail(`must match pattern "${schema.pattern}"`)
		}

		if(schema.format !== undefined && FORMATS[schema.format] && !FORMATS[schema.format](data)) {
			fail(`must match format "${schema.format}"`)
		}
	}

	if(Array.isArray(data)) {
		if(schema.minItems !== undefined && data.length < schema.minItems) {
			fail(`must NOT have fewer than ${schema.minItems} items`)
		}

		if(schema.items) {
			data.forEach((item, i) => check(schema.items, item, `${path}/${i}`, root, errors))
		}
	}

	if(isPlainObject(data)) {
		for(const key of schema.required || []) {
			if(data[key] === undefined) {
				fail(`must have required property '${key}'`)
			}
		}

		const props = schema.properties || {}
		for(const key of Object.keys(props)) {
			if(data[key] !== undefined) {
				check(props[key], data[key], `${path}/${escapePointer(key)}`, root, errors)
			}
		}

		if(schema.additionalProperties !== undefined) {
			for(const key of Object.keys(data)) {
				if(Object.hasOwn(props, key)) {
					continue
				}

				if(schema.additionalProperties === false) {
					fail(`must NOT have additional properties ("${key}")`)
				} else {
					check(schema.additionalProperties, data[key], `${path}/${escapePointer(key)}`, root, errors)
				}
			}
		}
	}

	for(const sub of schema.allOf || []) {
		check(sub, data, path, root, errors)
	}

	if(schema.oneOf) {
		const branchErrors = []
		let passing = 0
		for(const sub of schema.oneOf) {
			const own = []
			check(sub, data, path, root, own)
			if(own.length === 0) {
				passing++
			} else {
				branchErrors.push(...own)
			}
		}

		if(passing !== 1) {
			errors.push(...(passing === 0 ? branchErrors : []))
			fail('must match exactly one schema in oneOf')
		}
	}

	if(schema.if) {
		const scratch = []
		check(schema.if, data, path, root, scratch)
		if(scratch.length === 0 && schema.then) {
			const before = errors.length
			check(schema.then, data, path, root, errors)
			if(errors.length > before) {
				fail('must match "then" schema')
			}
		}
	}
}

/**
 * @param {object} schema
 * @param {unknown} data
 * @returns {{ path: string, message: string }[]} empty when valid. `path` is a JSON
 * pointer ("/" for the root); `message` starts with the path ("(root)" for the root).
 */
export function validate(schema, data) {
	const errors = []
	check(schema, data, '', schema, errors)
	return errors
}

/**
 * Keywords in `schema` (recursively) that validate() does not implement, as
 * "path: keyword" strings. Used where the schema is the developer's own (a trigger's
 * payloadSchema) so unchecked constraints are reported, not silently ignored.
 */
export function unsupportedKeywords(schema, path = '') {
	if(!isPlainObject(schema)) {
		return []
	}

	const out = []
	for(const [key, value] of Object.entries(schema)) {
		if(!KEYWORDS.includes(key) && !ANNOTATIONS.includes(key)) {
			out.push(`${path || '/'}: ${key}`)
		}

		if(key === 'items' && Array.isArray(value)) {
			out.push(`${path || '/'}: items (tuple form)`)
		}
	}

	for(const [key, sub] of Object.entries(schema.properties || {})) {
		out.push(...unsupportedKeywords(sub, `${path}/properties/${escapePointer(key)}`))
	}

	for(const key of ['items', 'additionalProperties', 'if', 'then']) {
		out.push(...unsupportedKeywords(schema[key], `${path}/${key}`))
	}

	for(const key of ['oneOf', 'allOf']) {
		;(Array.isArray(schema[key]) ? schema[key] : []).forEach((s, i) => out.push(...unsupportedKeywords(s, `${path}/${key}/${i}`)))
	}

	for(const [key, sub] of Object.entries(schema.definitions || {})) {
		out.push(...unsupportedKeywords(sub, `${path}/definitions/${escapePointer(key)}`))
	}

	return out
}

// patterns can come from a developer's own payloadSchema (in `dev`): a pattern
// that doesn't compile, or is implausibly long, is treated as never matching
// rather than throwing or risking a pathological regex
const MAX_PATTERN_LENGTH = 1000
const PATTERNS = new Map()
function patternMatches(pattern, data) {
	if(typeof pattern !== 'string' || pattern.length > MAX_PATTERN_LENGTH) {
		return false
	}

	if(!PATTERNS.has(pattern)) {
		let re = null
		try {
			re = new RegExp(pattern, 'u')
		} catch{}

		PATTERNS.set(pattern, re)
	}

	const re = PATTERNS.get(pattern)
	return !!re && re.test(data)
}
