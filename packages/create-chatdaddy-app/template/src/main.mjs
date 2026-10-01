import { readFileSync } from 'node:fs'
import { createKeyResolver, usesDevKey } from './keys.mjs'
import { log } from './log.mjs'
import { createApp } from './server.mjs'
import { InstallationStore } from './store.mjs'

const manifest = JSON.parse(readFileSync(new URL('../chatdaddy-app.json', import.meta.url), 'utf8'))

let getPublicKey
try {
	getPublicKey = createKeyResolver(process.env)
} catch(err) {
	log('error', err.message)
	process.exit(1)
}

if(usesDevKey(process.env)) {
	log('warn', 'trusting a development public key: for local testing only')
}

const store = await new InstallationStore(process.env.DATA_FILE || './data/installations.json').load()
const server = createApp({ appId: manifest.id, getPublicKey, store, log })
const port = Number(process.env.PORT || 3000)
server.listen(port, () => log('info', 'listening', { app: manifest.id, port }))
