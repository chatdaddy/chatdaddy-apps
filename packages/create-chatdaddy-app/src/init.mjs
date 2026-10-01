// `create-chatdaddy-app init <dir> [--name ...]`: copy template/ into <dir>.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEMPLATE_DIR = fileURLToPath(new URL('../template/', import.meta.url))
const SUBSTITUTED = new Set(['chatdaddy-app.json', 'package.json', 'README.md'])
const RENAMED = { gitignore: '.gitignore' } // npm would drop a real .gitignore from a package

export class InitError extends Error {}

/** manifest ids are lower-case slugs: a-z0-9 separated by single hyphens, 64 max */
export function slugify(text) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
}

function listFiles(dir, prefix = '') {
	return readdirSync(dir, { withFileTypes: true }).flatMap(e => (
		e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
	))
}

/**
 * @param {string} dir target directory; created if missing, must be empty if present
 * @param {{ name?: string }} [opts]
 * @returns {{ dir: string, appId: string, appName: string, files: string[] }}
 * @throws {InitError} for a non-empty target, an unusable name, or a target that is a file
 */
export function init(dir, opts = {}) {
	if(!dir) {
		throw new InitError('usage: create-chatdaddy-app init <dir> [--name "My App"]')
	}

	const target = resolve(dir)
	const appName = (opts.name ?? basename(target)).trim()
	const appId = slugify(appName)
	if(!appName || appName.length > 128 || !appId) {
		throw new InitError('the app name must be 1-128 characters and contain a letter or digit (it becomes the app id)')
	}

	if(existsSync(target)) {
		if(!statSync(target).isDirectory()) {
			throw new InitError(`${dir} exists and is not a directory`)
		}

		if(readdirSync(target).length > 0) {
			throw new InitError(`${dir} is not empty: refusing to overwrite. Pick a new or empty directory.`)
		}
	}

	const files = []
	for(const rel of listFiles(TEMPLATE_DIR)) {
		const name = basename(rel)
		let content = readFileSync(join(TEMPLATE_DIR, rel))
		if(SUBSTITUTED.has(rel)) {
			const esc = rel.endsWith('.json') ? s => JSON.stringify(s).slice(1, -1) : s => s
			content = Buffer.from(content.toString('utf8')
				.replaceAll('{{APP_ID}}', esc(appId))
				.replaceAll('{{APP_NAME}}', esc(appName)))
		}

		const out = rel.slice(0, rel.length - name.length) + (RENAMED[name] || name)
		const dest = join(target, out)
		mkdirSync(join(dest, '..'), { recursive: true })
		// 'wx': never overwrite, even if something appeared since the emptiness check
		writeFileSync(dest, content, { flag: 'wx' })
		files.push(out)
	}

	return { dir: target, appId, appName, files: files.sort() }
}
