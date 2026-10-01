// Rejects private / loopback / link-local hosts in manifest URLs and host allowlists.
// Ported rule-for-rule from ChatDaddy's publish-time validator.
//
// This is a naming-based check, not DNS resolution: it looks at the literal hostname or
// IP written in the manifest. A hostname that merely resolves to a private address
// (DNS rebinding) is not caught here; that is enforced where the outbound call is made.

const LOOPBACK_HOSTNAMES = new Set(['localhost', '0.0.0.0', '::1', '::'])

/**
 * true if `hostname` is a literal IPv4 address in a private/reserved range. Dotted
 * decimal only on purpose: callers pass `new URL(...).hostname`, and the WHATWG URL
 * parser normalises decimal (`2130706433`), hex (`0x7f000001`) and octal forms first.
 */
function isPrivateIpv4(hostname) {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
	if(!match) {
		return false
	}

	const octets = match.slice(1, 5).map(Number)
	if(octets.some(o => o > 255)) {
		return false
	}

	const [a, b] = octets
	return (
		a === 10 // 10.0.0.0/8
		|| (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12
		|| (a === 192 && b === 168) // 192.168.0.0/16
		|| a === 127 // 127.0.0.0/8 loopback
		|| (a === 169 && b === 254) // 169.254.0.0/16 link-local
		|| a === 0 // 0.0.0.0/8
	)
}

/**
 * IPv4 embedded in IPv6 (`::ffff:a.b.c.d` mapped, `::a.b.c.d` compatible), in dotted or
 * hex form (WHATWG URL normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`).
 * @returns the dotted IPv4, or undefined
 */
function embeddedIpv4(h) {
	const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
	if(dotted) {
		return dotted[1]
	}

	const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
	if(hex) {
		const hi = parseInt(hex[1], 16)
		const lo = parseInt(hex[2], 16)
		return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
	}

	return undefined
}

/** true if `hostname` is a literal IPv6 loopback/link-local/unique-local address */
function isPrivateIpv6(hostname) {
	const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
	if(h === '::1' || h === '::') {
		return true
	}

	const v4 = embeddedIpv4(h)
	if(v4) {
		return isPrivateIpv4(v4)
	}

	// fc00::/7 (unique local), fe80::/10 (link-local)
	return /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h)
}

/**
 * @param {string} host a bare hostname (as in `connections[].hosts`) or a full URL
 * (`privacyPolicyUrl`, `handler.baseUrl`, `connections[].authUrl` / `tokenUrl`)
 * @returns {boolean}
 */
export function isPrivateOrLoopbackHost(host) {
	let hostname
	try {
		hostname = new URL(host.includes('://') ? host : `https://${host}`).hostname
	} catch{
		// not parseable as a host at all: the schema layer (format/pattern) rejects it
		return false
	}

	// a trailing dot is the same host (`localhost.` == `localhost`)
	hostname = hostname.toLowerCase().replace(/\.+$/, '')
	if(LOOPBACK_HOSTNAMES.has(hostname)) {
		return true
	}

	if(hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
		return true
	}

	return isPrivateIpv4(hostname) || isPrivateIpv6(hostname)
}
