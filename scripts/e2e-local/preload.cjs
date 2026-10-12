// Test seam, loaded into bots with `node -r`. It changes NO bots source; it only moves the network edges:
//  1. @chatdaddy/client has hardcoded https://api.chatdaddy.tech base URLs (no env override), so appstore and auth
//     calls are rewritten to the local stub, and every other chatdaddy.tech call is refused.
//  2. bots' egress guard (src/utils/safe-egress.ts) refuses loopback, and handler.baseUrl must be https. For ONE
//     fake host (E2E_APP_HOST) the DNS lookup is answered with 127.0.0.1; the guard stays on for everything else.
//  3. any connection to a non-local host name is refused, so a bug here can never reach production.
const { createRequire } = require('module')
const net = require('net')

const req = createRequire(`${process.env.BOTS_DIR}/package.json`)
const { CLIENT_AXIOS } = req('@chatdaddy/client/lib/utils/configure-client')
const stub = process.env.E2E_STUB_URL
const appHost = process.env.E2E_APP_HOST

CLIENT_AXIOS.interceptors.request.use(cfg => {
	const u = new URL(cfg.url, cfg.baseURL)
	if(u.hostname.endsWith('chatdaddy.tech')) {
		if(!/^\/(appstore|auth)(\/|$)/.test(u.pathname)) {
			throw new Error(`e2e: blocked client call to ${u.hostname}${u.pathname}`)
		}

		cfg.url = stub + u.pathname + u.search
	}

	return cfg
})

const LOCAL = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function(...args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0]
	const opts = first && typeof first === 'object' ? first : undefined
	const host = opts ? (opts.host || opts.hostname) : (typeof args[1] === 'string' ? args[1] : undefined)
	if(host && !LOCAL.test(host)) {
		if(host !== appHost) {
			throw new Error(`e2e: blocked connection to ${host}`)
		}

		opts.lookup = (_h, o, cb) => (o?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))
	}

	return connect.apply(this, args)
}
