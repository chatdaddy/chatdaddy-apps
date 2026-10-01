import { CHATDADDY_PUBLIC_KEY } from './jwt.mjs'
import { createApp } from './server.mjs'
import { InstallationStore } from './store.mjs'

const need = name => {
	const v = process.env[name]
	if(!v) {
		console.error(`missing env var ${name}`)
		process.exit(1)
	}

	return v
}

const store = await new InstallationStore(process.env.DATA_FILE || './data/installations.json').load()
const server = createApp({
	appId: process.env.APP_ID || 'shopify-order-whatsapp',
	publicKey: process.env.CHATDADDY_PUBLIC_KEY || CHATDADDY_PUBLIC_KEY,
	store,
	shopifyWebhookSecret: need('SHOPIFY_WEBHOOK_SECRET'),
	botsUrl: need('CHATDADDY_BOTS_URL'),
})
const port = Number(process.env.PORT || 3000)
server.listen(port, () => console.log(`app-shopify-order listening on :${port}`))
