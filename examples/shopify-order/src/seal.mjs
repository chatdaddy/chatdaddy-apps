// Sealing for secrets at rest: AES-256-GCM, 12-byte random IV per seal, and the
// installation id bound in as additional authenticated data, so a sealed value
// copied onto another installation's record does not open.
// Format: v1.<iv>.<tag>.<ciphertext>, each part base64url.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Accepts 64 hex characters or base64/base64url of exactly 32 bytes.
 * @returns a 32-byte Buffer, or undefined (never throws, never echoes the input)
 */
export function parseSealKey(value) {
	if(typeof value !== 'string') {
		return undefined
	}

	const text = value.trim()
	if(/^[0-9a-fA-F]{64}$/.test(text)) {
		return Buffer.from(text, 'hex')
	}

	if(/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(text)) {
		const buf = Buffer.from(text, 'base64url')
		return buf.length === 32 ? buf : undefined
	}

	return undefined
}

export function seal(key, plaintext, aad) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	cipher.setAAD(Buffer.from(aad, 'utf8'))
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
	return ['v1', iv, cipher.getAuthTag(), ct].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

/** @returns the plaintext, or undefined for ANY problem (wrong key, wrong aad, tampering, bad format) */
export function unseal(key, sealed, aad) {
	try {
		const parts = typeof sealed === 'string' ? sealed.split('.') : []
		if(parts.length !== 4 || parts[0] !== 'v1') {
			return undefined
		}

		const [iv, tag, ct] = parts.slice(1).map(p => Buffer.from(p, 'base64url'))
		if(iv.length !== 12 || tag.length !== 16) {
			return undefined
		}

		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAAD(Buffer.from(aad, 'utf8'))
		decipher.setAuthTag(tag)
		return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
	} catch{
		return undefined
	}
}
