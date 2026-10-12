// set-client: register the provider's OAuth client id + secret for one oauth2 connection of an app,
// via bots `appOAuthClientPut`. The secret only ever comes from env or stdin and goes in a header
// (bots keeps headers out of logs); it is never printed, not even on error.
// sync fs reads below are intentional: one small file in a one-shot CLI
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_BOTS_URL = 'https://api.chatdaddy.tech/bots'

async function readAll(stream) {
	let s = ''
	for await (const c of stream) {
		s += c
	}

	return s
}

/** @returns {Promise<number>} exit code */
export async function setClient({ appDir, connection, clientId, secretStdin, env = process.env, stdin, fetch: doFetch = fetch, out, err }) {
	const token = env.CHATDADDY_TOKEN
	if(!token) {
		err('CHATDADDY_TOKEN is not set (a ChatDaddy token with the APPS_DEVELOP scope)')
		return 2
	}

	if(!appDir || !connection) {
		err('usage: set-client <app-dir> --connection <id> [--client-id <id>] [--secret-stdin]')
		return 2
	}

	let manifest
	try {
		const file = join(appDir, 'chatdaddy-app.json')
		if(statSync(file).size > 1024 * 1024) {
			err(`${file}: larger than 1 MiB, not a manifest`)
			return 2
		}

		manifest = JSON.parse(readFileSync(file, 'utf8'))
	} catch(e) {
		err(`${appDir}/chatdaddy-app.json: cannot read as JSON (${e.code || e.message})`)
		return 2
	}

	const conn = (manifest.connections || []).find(c => c?.id === connection)
	if(conn?.type !== 'oauth2') {
		err(conn
			? `connection "${connection}" is type "${conn.type}", not oauth2`
			: `no connection "${connection}" in the manifest`)
		return 2
	}

	clientId = clientId || env.CHATDADDY_OAUTH_CLIENT_ID
	if(!clientId) {
		err('client id missing: pass --client-id or set CHATDADDY_OAUTH_CLIENT_ID')
		return 2
	}

	// ponytail: strips one trailing newline only, so a secret with real surrounding spaces survives
	const secret = (secretStdin ? await readAll(stdin) : env.CHATDADDY_OAUTH_CLIENT_SECRET || '').replace(/\r?\n$/, '')
	if(!secret) {
		err('client secret missing: set CHATDADDY_OAUTH_CLIENT_SECRET or pipe it in with --secret-stdin (there is no flag, it would land in shell history)')
		return 2
	}

	const api = (env.CHATDADDY_BOTS_URL || DEFAULT_BOTS_URL).replace(/\/+$/, '')
	let host
	try {
		host = new URL(api)
	} catch{
		err('CHATDADDY_BOTS_URL is not a valid URL')
		return 2
	}

	if(host.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) {
		err('CHATDADDY_BOTS_URL must be https (the token and secret are sent to it)')
		return 2
	}

	try {
		const res = await doFetch(`${api}/apps/${encodeURIComponent(manifest.id)}/oauth-clients/${encodeURIComponent(connection)}`, {
			method: 'PUT',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-oauth-client-secret': secret },
			body: JSON.stringify({ clientId }),
			redirect: 'error',
			signal: AbortSignal.timeout(30_000),
		})
		if(!res.ok) {
			const text = await res.text()
			let msg = ''
			try { msg = JSON.parse(text).message } catch{ /* not JSON */ }
			err(`set-client failed: HTTP ${res.status} ${String(msg || '').split(secret).join('[redacted]').slice(0, 300)}`)
			return 1
		}

		out(`OAuth client set for ${manifest.id} / ${connection}`)
		return 0
	} catch(e) {
		err(`could not reach bots: ${e.name === 'TimeoutError' ? 'timed out' : String(e.message).split(secret).join('[redacted]')}`)
		return 1
	}
}
