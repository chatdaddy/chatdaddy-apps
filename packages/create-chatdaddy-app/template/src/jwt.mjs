// ES256 verification of the ChatDaddy-signed app token sent with POST /installed.
// Replicates typescript-client `verifyToken` (jsonwebtoken, algorithms: ['ES256'])
// with node:crypto only.
import { createPublicKey, verify } from 'node:crypto'

// ChatDaddy's public ES256 key, the same one @chatdaddy/client ships (src/utils/auth.ts PUBLIC_KEY)
export const CHATDADDY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEevVHEB81+mIuHJ6Ka2+GveuyAb2P
SNEGnm4K1V6HzZF0F9+mQS7N0UHNE+gv0OQIKi5D6e48ZCVytj3iX4Todg==
-----END PUBLIC KEY-----
`

const b64urlJson = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))

/**
 * @returns the decoded payload, or undefined for ANY problem (never throws)
 * @param {string} token
 * @param {string} publicKeyPem
 * @param {number} nowS
 */
export function verifyEs256(token, publicKeyPem, nowS) {
	try {
		const parts = token.split('.')
		if(parts.length !== 3) {
			return undefined
		}

		const header = b64urlJson(parts[0])
		if(header.alg !== 'ES256') {
			return undefined
		}

		const sig = Buffer.from(parts[2], 'base64url')
		if(sig.length !== 64) { // ieee-p1363 r||s for P-256
			return undefined
		}

		const ok = verify(
			'sha256',
			Buffer.from(`${parts[0]}.${parts[1]}`),
			{ key: createPublicKey(publicKeyPem), dsaEncoding: 'ieee-p1363' },
			sig
		)
		if(!ok) {
			return undefined
		}

		const payload = b64urlJson(parts[1])
		if(typeof payload.exp !== 'number' || payload.exp <= nowS) {
			return undefined
		}

		return payload
	} catch{
		return undefined
	}
}

/**
 * The token minted by auth `appAccessTokenPost` carries the app identity at
 * `user.metadata = { type: 'app', objectId: 'app_<appId>/inst_<installationId>' }`
 * and the team at `user.teamId` (auth generateJwt nests metadata under `user`).
 * @returns true only if the verified claims match the handshake body
 */
export function tokenMatchesInstall(payload, { appId, installationId, teamId }) {
	const user = payload?.user
	const meta = user?.metadata
	return meta?.type === 'app'
		&& meta.objectId === `app_${appId}/inst_${installationId}`
		&& user.teamId === teamId
}
