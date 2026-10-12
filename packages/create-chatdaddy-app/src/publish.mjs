// publish: register the app if new, then publish one immutable version, via appstore's
// appGet / appCreate / appVersionCreate. The token's team becomes the app's team.
import { readFileSync, statSync } from 'node:fs'
import { validateManifest } from './validate/index.mjs'

export const DEFAULT_APPSTORE_URL = 'https://api.chatdaddy.tech/appstore'
const MAX_BYTES = 1024 * 1024

/** @returns {Promise<number>} exit code */
export async function publish({ file, baseUrl, version, env = process.env, fetch: doFetch = fetch, out, err }) {
	const token = env.CHATDADDY_TOKEN
	if(!token) {
		err('CHATDADDY_TOKEN is not set (a ChatDaddy token with the APPS_DEVELOP scope)')
		return 2
	}

	if(!version) {
		err('--version is required (free-form, unique per app; versions are immutable)')
		return 2
	}

	let manifest
	try {
		if(statSync(file).size > MAX_BYTES) {
			err(`${file}: larger than ${MAX_BYTES} bytes, not a manifest`)
			return 2
		}

		manifest = JSON.parse(readFileSync(file, 'utf8'))
	} catch(e) {
		err(`${file}: cannot read as JSON (${e.code || e.message})`)
		return 2
	}

	if(baseUrl) {
		if(manifest?.handler?.type !== 'url') {
			err('--base-url only applies to a manifest whose handler.type is "url"')
			return 2
		}

		manifest = { ...manifest, handler: { ...manifest.handler, baseUrl } }
	}

	const r = validateManifest(manifest)
	if(!r.valid) {
		err(`${file}: INVALID, not publishing (${r.errors.length} problem${r.errors.length === 1 ? '' : 's'})`)
		for(const e of r.errors) {
			err(`  ${e.message}`)
		}

		return 1
	}

	const api = (env.CHATDADDY_APPSTORE_URL || DEFAULT_APPSTORE_URL).replace(/\/+$/, '')
	const host = new URL(api)
	if(host.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) {
		err('CHATDADDY_APPSTORE_URL must be https (the token is sent to it)')
		return 2
	}

	const call = async(method, path, body) => {
		const res = await doFetch(api + path, {
			method,
			headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30_000),
		})
		const text = await res.text()
		let json
		try { json = JSON.parse(text) } catch{ /* not JSON */ }
		return { status: res.status, ok: res.ok, json, text }
	}

	const fail = (what, res) => {
		err(`${what} failed: HTTP ${res.status} ${(res.json?.message || res.text || '').slice(0, 300)}`)
		return 1
	}

	try {
		const id = encodeURIComponent(manifest.id)
		const existing = await call('GET', `/apps/${id}`)
		if(existing.status === 404) {
			const created = await call('POST', '/apps', { id: manifest.id, name: manifest.name, description: manifest.description })
			if(!created.ok) {
				return fail('appCreate', created)
			}

			out(`registered new app ${manifest.id}`)
		} else if(existing.ok) {
			out(`app ${manifest.id} already registered`)
		} else {
			return fail('appGet', existing)
		}

		const v = await call('POST', `/apps/${id}/versions`, { version, manifest })
		if(!v.ok) {
			return fail('appVersionCreate', v)
		}

		out(`published ${manifest.id} version ${version} (handler ${manifest.handler.baseUrl})`)
		out('\nnext: in the ChatDaddy dashboard, open your team\'s apps and install it (consent screen).')
		return 0
	} catch(e) {
		err(`could not reach appstore: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`)
		return 1
	}
}
