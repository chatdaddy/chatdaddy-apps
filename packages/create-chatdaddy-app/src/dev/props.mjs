// Checks a value against a manifest property descriptor list (an action's
// inputProperties / outputProperties). Only what the manifest can express:
// required, type, array element type. Extra keys are reported as warnings.

const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)

function checkType(descriptor, value, where, problems) {
	const actual = typeOf(value)
	if(actual !== descriptor.type) {
		problems.push(`${where}: expected ${descriptor.type}, got ${actual}`)
		return
	}

	if(descriptor.type === 'array' && descriptor.items) {
		value.forEach((el, i) => checkType(descriptor.items, el, `${where}[${i}]`, problems))
	}
}

/**
 * @param {object[]} descriptors manifest property descriptors
 * @param {unknown} value what the app received or returned
 * @param {string} label for messages, e.g. "output"
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkProperties(descriptors, value, label) {
	const problems = []
	const warnings = []
	if(value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { problems: [`${label}: expected a JSON object, got ${typeOf(value)}`], warnings }
	}

	for(const d of descriptors) {
		const v = value[d.propertyPath]
		if(v === undefined) {
			if(d.required) {
				problems.push(`${label}.${d.propertyPath}: required but missing`)
			}

			continue
		}

		checkType(d, v, `${label}.${d.propertyPath}`, problems)
	}

	const declared = new Set(descriptors.map(d => d.propertyPath))
	for(const key of Object.keys(value)) {
		if(!declared.has(key)) {
			warnings.push(`${label}.${key}: not declared in the manifest`)
		}
	}

	return { problems, warnings }
}
