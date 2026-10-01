// JSON-file installation store. One record per installation:
// { installationId, teamId, appId, signingSecret, previousSecret?, previousSecretExpiresAt? }
// Writes are atomic (tmp + rename) and serialised. Secrets are plaintext on disk:
// protect the file (mode 0600) and the directory.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** how long the old secret keeps verifying after a re-handshake (spec rev2 "Rotation") */
export const PREVIOUS_SECRET_WINDOW_S = 15 * 60

export class InstallationStore {
	/** @param {string | undefined} file path; undefined keeps it in memory only */
	constructor(file) {
		this.file = file
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
		if(prev && prev.signingSecret !== signingSecret) {
			rec.previousSecret = prev.signingSecret
			rec.previousSecretExpiresAt = nowS + PREVIOUS_SECRET_WINDOW_S
		} else if(prev?.previousSecret) {
			// a repeat delivery of the same secret must not shorten or drop an open window
			rec.previousSecret = prev.previousSecret
			rec.previousSecretExpiresAt = prev.previousSecretExpiresAt
		}

		this.records[installationId] = rec
		await this.#persist()
	}

	#persist() {
		if(!this.file) {
			return Promise.resolve()
		}

		const snapshot = JSON.stringify(this.records, null, 2)
		const file = this.file
		this.queue = this.queue.then(async() => {
			await mkdir(dirname(file), { recursive: true })
			const tmp = `${file}.tmp`
			await writeFile(tmp, snapshot, { mode: 0o600 })
			await rename(tmp, file)
		})
		return this.queue
	}
}
