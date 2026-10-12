// Runs INSIDE bots' process (node -r @swc-node/register -r preload.cjs), so it calls the real code paths.
//   handshake : the cron job body (claim due installs, mint app token, POST /installed, check the ack)
//   action    : executeAppAction, the helper a flow's app step reaches (app-utils getOutputFromApp)
//   kms       : seal and open through connection-crypto against the endpoint from the AWS_* env
const { createRequire } = require('module')
const req = createRequire(`${process.env.BOTS_DIR}/package.json`)
const { getTypeOrmConnection, logger } = req('@chatdaddy/rest-api-builder')

async function main() {
	const [mode, arg] = process.argv.slice(2)
	let result
	if(mode === 'kms') {
		const { sealSecret, openSecret } = req('./src/utils/connection-crypto')
		const ctx = { teamId: 't', installationId: 'i', subjectId: 's', purpose: 'e2e' }
		const sealed = await sealSecret({ ...ctx, secret: { hello: 'world' } })
		const opened = await openSecret({ ...ctx, row: {
			secretCiphertext: sealed.ciphertext, secretIv: sealed.iv, secretAuthTag: sealed.authTag, encryptedDataKey: sealed.encryptedDataKey
		} })
		result = { roundTrip: opened.hello === 'world' }
	} else if(mode === 'handshake') {
		const db = await getTypeOrmConnection()
		await req('./src/functions/cron-app-handshake').handler({ db })
		result = { ran: true }
	} else if(mode === 'action') {
		const { teamId, appId, actionId, input } = JSON.parse(arg)
		const db = await getTypeOrmConnection()
		const out = await req('./src/utils/app-actions').executeAppAction(appId, {
			actionId, db, input, state: {}, logger,
			recipient: { id: 'e2e-chat', accountId: 'e2e-account', contact: { id: 'e2e-contact' } },
			auth: { teamId, getChatDaddyAccessToken: () => 'unused' }
		})
		result = { statusCode: out.statusCode, body: out.body }
	}

	console.log(`RESULT:${JSON.stringify(result)}`)
	process.exit(0)
}

main().catch(err => {
	// message only: an axios error carries request config
	console.log(`RESULT:${JSON.stringify({ error: String(err?.message || err).slice(0, 300), code: err?.output?.statusCode })}`)
	process.exit(1)
})
