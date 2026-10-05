// JSON-file installation store. One record per installation:
// { installationId, teamId, appId, signingSecret, previousSecret?, previousSecretExpiresAt?,
//   shopifyWebhookSecretSealed? }
// Writes are atomic (tmp + rename) and serialised. The ChatDaddy signing secrets are
// plaintext on disk: protect the file (mode 0600) and the directory. The shop's Shopify
// webhook secret is sealed (AES-256-GCM, see seal.mjs) and only ever read back through
// webhookSecretFor(), which no route returns.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { seal, unseal } from './seal.mjs'

/** how long the old secret keeps verifying after a re-handshake */
export const PREVIOUS_SECRET_WINDOW_S = 15 * 60

export class InstallationStore {
	/**
	 * @param {string | undefined} file path; undefined keeps it in memory only
	 * @param {{ sealKey?: Buffer }} [opts] 32-byte key that seals the Shopify webhook secrets
	 */
	constructor(file, { sealKey } = {}) {
		this.file = file
		this.sealKey = sealKey
		this.records = {}
		this.queue = Promise.resolve()
	}

	async load() {
		if(!this.file) {
			return this
		}

		try {
			this.records = JSON.parse(await readFile(this.file, 'utf8'))
		} catch(err) {
			if(err.code !== 'ENOENT') {
				throw err
			}
		}

		return this
	}

	get(installationId) {
		return Object.hasOwn(this.records, installationId) ? this.records[installationId] : undefined
	}

	/** current secret, plus the previous one while its window is open */
	secretsFor(installationId, nowS) {
		const rec = this.get(installationId)
		if(!rec) {
			return []
		}

		const secrets = [rec.signingSecret]
		if(rec.previousSecret && rec.previousSecretExpiresAt > nowS) {
			secrets.push(rec.previousSecret)
		}

		return secrets
	}

	/** the secret outbound calls are signed with */
	currentSecret(installationId) {
		return this.get(installationId)?.signingSecret
	}

	/** store from a handshake; a changed secret demotes the old one to `previousSecret` */
	async saveHandshake({ installationId, teamId, appId, signingSecret }, nowS) {
		const prev = this.get(installationId)
		const rec = { installationId, teamId, appId, signingSecret }
		if(prev?.shopifyWebhookSecretSealed) {
			// a re-handshake (rotation) must not wipe the shop's webhook secret
			rec.shopifyWebhookSecretSealed = prev.shopifyWebhookSecretSealed
		}

		if(prev && prev.signingSecret !== signingSecret) {
			rec.previousSecret = prev.signingSecret
			rec.previousSecretExpiresAt = nowS + PREVIOUS_SECRET_WINDOW_S
		} else if(prev?.previousSecret) {
			// a repeat delivery of the same secret must not shorten or drop an open window
			rec.previousSecret = prev.previousSecret
			rec.previousSecretExpiresAt = prev.previousSecretExpiresAt
		}

		await this.#commit(installationId, rec)
	}

	/** seal and store the shop's Shopify webhook secret on an existing installation */
	async setWebhookSecret(installationId, secret) {
		const prev = this.get(installationId)
		if(!prev) {
			throw new Error('unknown installation')
		}

		if(!this.sealKey) {
			throw new Error('no seal key configured')
		}

		await this.#commit(installationId, {
			...prev, shopifyWebhookSecretSealed: seal(this.sealKey, secret, installationId),
		})
	}

	/** the unsealed Shopify webhook secret, or undefined (none set, unknown installation, unreadable) */
	webhookSecretFor(installationId) {
		const sealed = this.get(installationId)?.shopifyWebhookSecretSealed
		return sealed && this.sealKey ? unseal(this.sealKey, sealed, installationId) : undefined
	}

	/** uninstall: drop the whole record, signing secrets and sealed webhook secret included */
	async deleteInstallation(installationId) {
		await this.#commit(installationId, undefined)
	}

	// memory and disk move together: a failed write puts the old record back and rethrows
	async #commit(installationId, rec) {
		const prev = this.get(installationId)
		if(rec) {
			this.records[installationId] = rec
		} else {
			delete this.records[installationId]
		}

		try {
			await this.#persist()
		} catch(err) {
			if(prev) {
				this.records[installationId] = prev
			} else {
				delete this.records[installationId]
			}

			throw err
		}
	}

	#persist() {
		if(!this.file) {
			return Promise.resolve()
		}

		const snapshot = JSON.stringify(this.records, null, 2)
		const file = this.file
		const write = this.queue.then(async() => {
			await mkdir(dirname(file), { recursive: true })
			const tmp = `${file}.tmp`
			await writeFile(tmp, snapshot, { mode: 0o600 })
			await rename(tmp, file)
		})
		// the caller sees this write's failure; the queue itself never stays rejected,
		// so one failed write doesn't fail every later one
		this.queue = write.catch(() => undefined)
		return write
	}
}
