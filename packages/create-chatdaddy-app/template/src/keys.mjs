// Which ES256 public key verifies the token ChatDaddy sends with POST /installed.
//
// Production ALWAYS uses ChatDaddy's real public key (jwt.mjs). The only exception is
// local development: `create-chatdaddy-app dev` plays ChatDaddy with a throwaway key
// pair, and this app can be told to trust that public key through
//   CHATDADDY_DEV_PUBLIC_KEY       the PEM itself, or
//   CHATDADDY_DEV_PUBLIC_KEY_FILE  a file holding the PEM (re-read on every handshake,
//                                  so restarting `dev` does not need an app restart)
// Both are refused when NODE_ENV=production: the app throws at start-up instead of
// silently trusting a key anyone can generate. NODE_ENV unset counts as "not
// production", so set NODE_ENV=production on every real deployment.
import { readFileSync } from 'node:fs'
import { CHATDADDY_PUBLIC_KEY } from './jwt.mjs'

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {() => string} returns the PEM to verify the handshake token with
 * @throws when a dev key is configured under NODE_ENV=production, or both forms are set
 */
export function createKeyResolver(env = process.env) {
	const inline = env.CHATDADDY_DEV_PUBLIC_KEY
	const file = env.CHATDADDY_DEV_PUBLIC_KEY_FILE
	if(!inline && !file) {
		return () => CHATDADDY_PUBLIC_KEY
	}

	if(env.NODE_ENV === 'production') {
		throw new Error(
			'CHATDADDY_DEV_PUBLIC_KEY / CHATDADDY_DEV_PUBLIC_KEY_FILE is set while NODE_ENV=production. '
			+ 'Refusing to start: production must use ChatDaddy\'s real public key. Unset the variable.'
		)
	}

	if(inline && file) {
		throw new Error('set only one of CHATDADDY_DEV_PUBLIC_KEY and CHATDADDY_DEV_PUBLIC_KEY_FILE')
	}

	return () => inline || readFileSync(file, 'utf8')
}

/** true when the resolver was built from a dev key (for a start-up warning) */
export const usesDevKey = env => Boolean(env.CHATDADDY_DEV_PUBLIC_KEY || env.CHATDADDY_DEV_PUBLIC_KEY_FILE)
