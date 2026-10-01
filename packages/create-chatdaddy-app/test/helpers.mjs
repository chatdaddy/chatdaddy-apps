import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { init } from '../src/init.mjs'

export const PKG = fileURLToPath(new URL('..', import.meta.url))
export const BIN = join(PKG, 'bin', 'create-chatdaddy-app.mjs')

export const tmp = () => mkdtempSync(join(tmpdir(), 'cd-kit-'))
export const rmrf = dir => rmSync(dir, { recursive: true, force: true })

/**
 * Scaffolds a fresh app into a temp dir and imports its real modules, so the dev loop
 * runs against exactly what `init` produces.
 */
export async function scaffold(name = 'Loop App') {
	const root = tmp()
	const dir = join(root, 'app')
	init(dir, { name })
	const load = f => import(pathToFileURL(join(dir, 'src', f)).href)
	const [server, store, keys, trigger] = await Promise.all(['server.mjs', 'store.mjs', 'keys.mjs', 'trigger.mjs'].map(load))
	return { root, dir, server, store, keys, trigger, cleanup: () => rmrf(root) }
}

export const listen = (server, host = '127.0.0.1') => new Promise(r => server.listen(0, host, () => r(`http://${host}:${server.address().port}`)))
export const close = server => new Promise(r => server.close(r))

/** env for a child `node --test`: without NODE_TEST_CONTEXT the child would think it is a worker of this run */
export function cleanEnv(extra = {}) {
	const env = { ...process.env, ...extra }
	delete env.NODE_TEST_CONTEXT
	return env
}
