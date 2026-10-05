// CLI: node src/send-trigger.mjs <triggerId> '<payload json>' [installationId]
// Needs CHATDADDY_BOTS_URL. Uses the signing secret stored by the handshake.
import { log } from './log.mjs'
import { InstallationStore } from './store.mjs'
import { sendTrigger } from './trigger.mjs'

const [triggerId, payloadJson, wanted] = process.argv.slice(2)
const botsUrl = process.env.CHATDADDY_BOTS_URL
if(!triggerId || !payloadJson || !botsUrl) {
	log('error', 'usage: CHATDADDY_BOTS_URL=<url> node src/send-trigger.mjs <triggerId> \'<payload json>\' [installationId]')
	process.exit(2)
}

const store = await new InstallationStore(process.env.DATA_FILE || './data/installations.json').load()
const ids = Object.keys(store.records)
const installationId = wanted || (ids.length === 1 ? ids[0] : undefined)
if(!installationId || !store.get(installationId)) {
	log('error', ids.length ? 'pass an installation id' : 'no installation yet: install the app first', { installations: ids })
	process.exit(2)
}

const res = await sendTrigger({
	botsUrl, installationId, triggerId, payload: JSON.parse(payloadJson), secret: store.currentSecret(installationId),
})
log(res.ok ? 'info' : 'error', 'trigger sent', { status: res.status, eventId: res.eventId, response: res.body })
process.exit(res.ok ? 0 : 1)
