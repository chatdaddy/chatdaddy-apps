import { CHATDADDY_PUBLIC_KEY } from './jwt.mjs'
import { parseSealKey } from './seal.mjs'
import { ADMIN_TOKEN_MIN_LENGTH, createApp } from './server.mjs'
import { InstallationStore } from './store.mjs'

// structured JSON lines on stdout/stderr; never log request bodies or secrets
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

// never print the key or the token, only that one is missing or malformed
const sealKey = parseSealKey(need('WEBHOOK_SECRET_KEY'))
if(!sealKey) {
	log('error', 'WEBHOOK_SECRET_KEY must be 32 bytes: 64 hex characters or base64')
	process.exit(1)
}

const adminToken = need('ADMIN_TOKEN')
if(adminToken.length < ADMIN_TOKEN_MIN_LENGTH) {
	log('error', `ADMIN_TOKEN must be at least ${ADMIN_TOKEN_MIN_LENGTH} characters`)
	process.exit(1)
}

const store = await new InstallationStore(process.env.DATA_FILE || './data/installations.json', { sealKey }).load()
const server = createApp({
	appId: process.env.APP_ID || 'shopify-order-whatsapp',
	publicKey: process.env.CHATDADDY_PUBLIC_KEY || CHATDADDY_PUBLIC_KEY,
	store,
	adminToken,
	botsUrl: need('CHATDADDY_BOTS_URL'),
})
const port = Number(process.env.PORT || 3000)
server.listen(port, () => log('info', 'app-shopify-order listening', { port }))
