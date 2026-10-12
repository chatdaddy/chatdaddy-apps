// App-side state in SQLite (node:sqlite, built into Node 22.13+; no dependency):
//   installations  shop <-> installation mapping, ChatDaddy signing secrets (plaintext: protect the volume)
//   webhooks       Shopify webhook subscription ids per installation
//   dedupe         webhook ids and semantic keys already handled (pruned after DEDUPE_TTL_S)
// Everything for an installation is removed by deleteInstallation (uninstall / shop/redact).
// node:sqlite prints an ExperimentalWarning on Node 22; the API is stable enough for this table set.
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** how long the old secret keeps verifying after a re-handshake */
export const PREVIOUS_SECRET_WINDOW_S = 15 * 60
export const DEDUPE_TTL_S = 7 * 24 * 3600

export class ShopConflictError extends Error {}

export class InstallationStore {
	/** @param {string | undefined} file path; undefined keeps it in memory only */
	constructor(file) {
		if(file) {
			mkdirSync(dirname(file), { recursive: true })
		}

		this.db = new DatabaseSync(file || ':memory:')
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS installations (
				installation_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, app_id TEXT NOT NULL,
				signing_secret TEXT NOT NULL, previous_secret TEXT, previous_secret_expires_at INTEGER,
				shop TEXT UNIQUE
			);
			CREATE TABLE IF NOT EXISTS webhooks (
				installation_id TEXT NOT NULL, topic TEXT NOT NULL, shopify_id TEXT NOT NULL,
				PRIMARY KEY (installation_id, topic)
			);
			CREATE TABLE IF NOT EXISTS dedupe (
				installation_id TEXT NOT NULL, key TEXT NOT NULL, seen_at INTEGER NOT NULL,
				PRIMARY KEY (installation_id, key)
			);
		`)
		if(file) {
			try {
				chmodSync(file, 0o600)
			} catch{}
		}
	}

	get(installationId) {
		const r = this.db.prepare('SELECT * FROM installations WHERE installation_id = ?').get(installationId)
		return r && {
			installationId: r.installation_id, teamId: r.team_id, appId: r.app_id, signingSecret: r.signing_secret,
			previousSecret: r.previous_secret, previousSecretExpiresAt: r.previous_secret_expires_at, shop: r.shop,
		}
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
	saveHandshake({ installationId, teamId, appId, signingSecret }, nowS) {
		const prev = this.get(installationId)
		let previous = null
		let expires = null
		if(prev && prev.signingSecret !== signingSecret) {
			previous = prev.signingSecret
			expires = nowS + PREVIOUS_SECRET_WINDOW_S
		} else if(prev?.previousSecret) {
			// a repeat delivery of the same secret must not shorten or drop an open window
			previous = prev.previousSecret
			expires = prev.previousSecretExpiresAt
		}

		// UPSERT keeps `shop`: a re-handshake must not forget the linked store
		this.db.prepare(`
			INSERT INTO installations (installation_id, team_id, app_id, signing_secret, previous_secret, previous_secret_expires_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(installation_id) DO UPDATE SET team_id = excluded.team_id, app_id = excluded.app_id,
				signing_secret = excluded.signing_secret, previous_secret = excluded.previous_secret,
				previous_secret_expires_at = excluded.previous_secret_expires_at
		`).run(installationId, teamId, appId, signingSecret, previous, expires)
	}

	/** link a shop ("my-store.myshopify.com") to an installation; one shop belongs to one installation */
	setShop(installationId, shop) {
		const owner = this.db.prepare('SELECT installation_id FROM installations WHERE shop = ?').get(shop)
		if(owner && owner.installation_id !== installationId) {
			throw new ShopConflictError('shop is linked to another installation')
		}

		this.db.prepare('UPDATE installations SET shop = ? WHERE installation_id = ?').run(shop, installationId)
	}

	installationForShop(shop) {
		return this.db.prepare('SELECT installation_id FROM installations WHERE shop = ?').get(shop)?.installation_id
	}

	/** @param {{ topic: string, id: string }[]} subs */
	saveWebhooks(installationId, subs) {
		const ins = this.db.prepare('INSERT OR REPLACE INTO webhooks (installation_id, topic, shopify_id) VALUES (?, ?, ?)')
		for(const s of subs) {
			ins.run(installationId, s.topic, s.id)
		}
	}

	/** @returns {{ topic: string, id: string }[]} */
	webhooksFor(installationId) {
		return this.db.prepare('SELECT topic, shopify_id AS id FROM webhooks WHERE installation_id = ?').all(installationId)
			.map(r => ({ topic: r.topic, id: r.id }))
	}

	/** true the first time `key` is seen for this installation; false for a repeat */
	claim(installationId, key, nowS) {
		this.db.prepare('DELETE FROM dedupe WHERE seen_at < ?').run(nowS - DEDUPE_TTL_S)
		return this.db.prepare('INSERT OR IGNORE INTO dedupe (installation_id, key, seen_at) VALUES (?, ?, ?)')
			.run(installationId, key, nowS).changes === 1
	}

	/** give a claim back (the work failed, so a later delivery may try again) */
	release(installationId, key) {
		this.db.prepare('DELETE FROM dedupe WHERE installation_id = ? AND key = ?').run(installationId, key)
	}

	/** uninstall / shop/redact: drop every row for the installation */
	deleteInstallation(installationId) {
		for(const t of ['webhooks', 'dedupe']) {
			this.db.prepare(`DELETE FROM ${t} WHERE installation_id = ?`).run(installationId)
		}

		this.db.prepare('DELETE FROM installations WHERE installation_id = ?').run(installationId)
	}
}
