// Connection rules that JSON Schema cannot express: host templates, input declarations,
// the oauth2 host tie and the header floor. The structural half (required fields per
// connection type, `inputs` <= 3) is in schema.mjs. Ported rule-for-rule from ChatDaddy's
// publish-time validator.
import { isPrivateOrLoopbackHost } from './hosts.mjs'
import { publicSuffixSection } from './public-suffix.mjs'

/**
 * Private-section public suffixes that a host TEMPLATE may still use. These are provider tenant
 * domains where the connect-time input names the customer's own tenant and the admin confirms
 * the filled host. Adding one is a reviewed code change. It is matched
 * exactly, applies only to templates (exact hosts are never checked against the list), and
 * never to an ICANN-section suffix.
 */
export const TENANT_SUFFIX_ALLOWLIST = ['myshopify.com']

// RFC 7230 token characters
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const DENIED_HEADERS = new Set([
	'host', 'cookie', 'connection', 'transfer-encoding', 'content-length', 'te', 'upgrade', 'x-real-ip',
	'forwarded', 'via', 'set-cookie', 'keep-alive', 'expect',
	'x-original-url', 'x-rewrite-url', 'x-http-method-override', 'x-http-method', 'x-method-override',
])
const DENIED_HEADER_PREFIXES = ['proxy-', 'x-forwarded-']
// a credential prefix is printable ASCII (0x20-0x7E): CR, LF, tab and every other control or
// non-ASCII character is refused
const HEADER_PREFIX_FORBIDDEN = /[^\x20-\x7e]/
const SUFFIX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const TEMPLATE = /^\{([^{}]*)\}\.([^{}]*)$/

/**
 * Why `name` may not be used as a request header name, or undefined if it may. Case
 * insensitive. `authorization` is allowed only as a connection's own credential header.
 * @param {string} name
 * @param {{ allowAuthorization: boolean }} opts
 * @returns {string | undefined}
 */
export function headerNameProblem(name, opts) {
	if(!HEADER_TOKEN.test(name)) {
		return `"${name.replace(/[\r\n]/g, '?')}" is not a valid header name (RFC 7230 token characters only)`
	}

	const lower = name.toLowerCase()
	if(DENIED_HEADERS.has(lower) || DENIED_HEADER_PREFIXES.some(p => lower.startsWith(p))) {
		return `header "${name}" is not allowed`
	}

	if(lower === 'authorization' && !opts.allowAuthorization) {
		return 'header "authorization" is only allowed as the connection\'s headerName'
	}

	return undefined
}

/** hostname as `new URL()` normalises it, lowercase, trailing dots stripped */
function normaliseHost(host) {
	let hostname = host
	try {
		hostname = new URL(host.includes('://') ? host : `https://${host}`).hostname
	} catch{}

	return hostname.toLowerCase().replace(/\.+$/, '')
}

/** true if `new URL()` leaves `host` exactly as written (and does not throw) */
function isIdentityHost(host) {
	try {
		return new URL(`https://${host}`).hostname === host
	} catch{
		return false
	}
}

/**
 * an IP literal in any form the URL parser accepts: bracketed IPv6, or a last label the parser
 * reads as a number (`127.0.0.1`, `127.1`, `2130706433`, `0x7f000001`)
 */
function isIpLiteral(host) {
	return /^\[.*\]$/.test(host) || /^(?:[0-9]+|0x[0-9a-f]*)$/i.test(host.slice(host.lastIndexOf('.') + 1))
}

/** check one `hosts[]` template; returns the error messages (none if it is sound) */
function templateProblems(host, inputIds) {
	const match = TEMPLATE.exec(host)
	if(!match) {
		return [`malformed host template "${host}": use "{<inputId>}.<suffix>" with the placeholder as the whole leftmost label`]
	}

	const [, placeholder, suffix] = match
	const problems = []
	if(!inputIds.has(placeholder)) {
		problems.push(`host template placeholder "{${placeholder}}" does not name a declared input`)
	}

	if(suffix.endsWith('.')) {
		problems.push(`host template suffix "${suffix}" must not end with a dot`)
	} else if(!SUFFIX.test(suffix)) {
		problems.push(`host template suffix "${suffix}" must be lowercase ASCII labels (letters, digits, hyphens)`)
	} else if(suffix.split('.').length < 2) {
		problems.push(`host template suffix "${suffix}" must have at least two labels`)
	} else if(/^[0-9]+$/.test(suffix.slice(suffix.lastIndexOf('.') + 1))) {
		// no real TLD is numeric, and a numeric last label makes the whole host an IPv4 address
		// to the URL parser (`192` + `.168.1` is 192.168.0.1)
		problems.push(`host template suffix "${suffix}" must not end in a numeric label`)
	} else if(!isIdentityHost(`x.${suffix}`)) {
		problems.push(`host template suffix "${suffix}" must equal its own URL normalisation`)
	} else {
		const section = publicSuffixSection(suffix)
		if(section === 'icann' || (section === 'private' && !TENANT_SUFFIX_ALLOWLIST.includes(suffix))) {
			problems.push(`host template suffix "${suffix}" must not be a public suffix`)
		}
	}

	if(isPrivateOrLoopbackHost(suffix)) {
		problems.push(`private/loopback hosts are not allowed ("${suffix}")`)
	}

	return problems
}

function compiles(pattern) {
	try {
		new RegExp(pattern, 'u')
		return true
	} catch{
		return false
	}
}

/** inputs: unique ids, advisory pattern must compile; returns the declared ids */
function checkInputs(c, base, add) {
	const inputIds = new Set()
	for(const [k, input] of (Array.isArray(c.inputs) ? c.inputs : []).entries()) {
		if(!input || typeof input !== 'object') {
			continue
		}

		if(typeof input.id === 'string') {
			if(inputIds.has(input.id)) {
				add(`${base}/inputs`, `duplicate input id "${input.id}"`)
			}

			inputIds.add(input.id)
		}

		if(typeof input.pattern === 'string') {
			// the 200-character cap is the schema's (maxLength)
			if(!compiles(input.pattern)) {
				add(`${base}/inputs/${k}/pattern`, 'pattern does not compile as a regular expression')
			}
		}
	}

	return inputIds
}

/** an exact `hosts[]` entry must be a bare, already-normalised, lower-case hostname, not an IP */
function exactHostProblems(host) {
	if(isIpLiteral(host)) {
		return [`exact host "${host}" must not be an IP address`]
	}

	if(!isIdentityHost(host)) {
		return [`exact host "${host}" must be a bare hostname that equals its own URL normalisation (no port, userinfo, path, query, fragment, escapes or upper case)`]
	}

	if(!SUFFIX.test(host)) {
		return [`exact host "${host}" must be lower-case labels of letters, digits and hyphens (no wildcard, empty label or trailing dot)`]
	}

	return []
}

/** hosts: exact hosts and at most one template; returns the normalised exact hosts */
function checkHosts(c, base, inputIds, add) {
	const exactHosts = new Set()
	let templates = 0
	for(const [j, host] of (Array.isArray(c.hosts) ? c.hosts : []).entries()) {
		if(typeof host !== 'string') {
			continue
		}

		if(!host.includes('{') && !host.includes('}')) {
			exactHosts.add(normaliseHost(host))
			for(const problem of exactHostProblems(host)) {
				add(`${base}/hosts/${j}`, problem)
			}

			continue
		}

		if(++templates === 2) {
			add(`${base}/hosts`, 'at most one host template per connection')
		}

		for(const problem of templateProblems(host, inputIds)) {
			add(`${base}/hosts/${j}`, problem)
		}
	}

	return exactHosts
}

/** header floor */
function checkHeaders(c, base, add) {
	if(typeof c.headerName === 'string') {
		const problem = headerNameProblem(c.headerName, { allowAuthorization: true })
		if(problem) {
			add(`${base}/headerName`, problem)
		}
	}

	if(typeof c.headerPrefix === 'string' && HEADER_PREFIX_FORBIDDEN.test(c.headerPrefix)) {
		add(`${base}/headerPrefix`, 'headerPrefix must be printable ASCII (no CR, LF, tab or other control characters)')
	}

	const seen = new Set()
	for(const [j, name] of (Array.isArray(c.forwardHeaders) ? c.forwardHeaders : []).entries()) {
		if(typeof name !== 'string') {
			continue
		}

		const problem = headerNameProblem(name, { allowAuthorization: false })
		if(problem) {
			add(`${base}/forwardHeaders/${j}`, problem)
		}

		if(seen.has(name.toLowerCase())) {
			add(`${base}/forwardHeaders`, `duplicate forwardHeaders entry "${name}"`)
		}

		seen.add(name.toLowerCase())
	}
}

/**
 * @param {unknown} connections the manifest's `connections` (any shape)
 * @param {{ path: string, message: string }[]} errors appended to
 */
export function validateConnections(connections, errors) {
	if(!Array.isArray(connections)) {
		return
	}

	const add = (path, message) => errors.push({ path, message: `${path}: ${message}` })
	for(const [i, c] of connections.entries()) {
		if(!c || typeof c !== 'object') {
			continue
		}

		const base = `/connections/${i}`
		const exactHosts = checkHosts(c, base, checkInputs(c, base, add), add)

		// oauth2: the auth and token endpoints must be exact hosts of this connection
		if(c.type === 'oauth2') {
			for(const field of ['authUrl', 'tokenUrl']) {
				const url = c[field]
				if(typeof url === 'string' && url && !exactHosts.has(normaliseHost(url))) {
					add(`${base}/${field}`, `host of ${field} ("${normaliseHost(url)}") must be listed in hosts as an exact host (a host template does not count)`)
				}
			}
		}

		checkHeaders(c, base, add)
	}
}
