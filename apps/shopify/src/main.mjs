import { CHATDADDY_PUBLIC_KEY } from './jwt.mjs'
import { unavailableProxy } from './proxy.mjs'
import { createApp } from './server.mjs'
import { InstallationStore } from './store.mjs'

// structured JSON lines on stdout/stderr; never log request bodies, phones or secrets
const log = (level, msg, extra = {}) => {
	const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra })
	;(level === 'error' ? process.stderr : process.stdout).write(line + '\n')
}

const need = name => {
	const v = process.env[name]
	if(!v) {
		log('error', 'missing env var', { name })
		process.exit(1)
	}

	return v
}

const store = new InstallationStore(process.env.DATA_FILE || './data/app.db')
const server = createApp({
	appId: process.env.APP_ID || 'chatdaddy-shopify',
	publicKey: process.env.CHATDADDY_PUBLIC_KEY || CHATDADDY_PUBLIC_KEY,
	store,
	shopifyClientSecret: need('SHOPIFY_CLIENT_SECRET'),
	botsUrl: need('CHATDADDY_BOTS_URL'),
	publicUrl: need('PUBLIC_URL'),
	// TODO(P5 A-5): the real connection-proxy client replaces this
	proxy: unavailableProxy,
	log: ({ msg, ...rest }) => log('info', msg, rest),
})
const port = Number(process.env.PORT || 3000)
server.listen(port, () => log('info', 'chatdaddy-shopify listening', { port }))
