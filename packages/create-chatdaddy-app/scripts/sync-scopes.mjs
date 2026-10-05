// Regenerates the validator's catalogue snapshots from the PUBLIC chatdaddy/typescript-client:
//   src/data/scopes.json   every scope name, and the subset marked appGrantable:true
//   src/data/events.json   the EventName values (valid `eventSubscriptions`)
//
//   node scripts/sync-scopes.mjs                       fetch from GitHub (branch main)
//   node scripts/sync-scopes.mjs --ref <branch|sha>    fetch another ref
//   node scripts/sync-scopes.mjs --local <clone-dir>   read a local clone instead (no network)
//
// Not run by the tests. Re-run it, and commit the result, when ChatDaddy adds or changes
// scopes or events; `validate` is only as current as the last sync.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO = 'chatdaddy/typescript-client'
const SCOPES_PATH = 'src/scopes.json'
const EVENTS_PATH = 'src/OpenAPI/events/api.ts'
const dataDir = fileURLToPath(new URL('../src/data/', import.meta.url))

/** @returns {{ known: string[], appGrantable: string[] }} sorted scope names */
export function parseScopes(json) {
	const scopes = typeof json === 'string' ? JSON.parse(json) : json
	const known = Object.keys(scopes).sort()
	return { known, appGrantable: known.filter(k => scopes[k]?.appGrantable === true) }
}

/** @returns {string[]} the values of `export const EventName = { ... } as const` */
export function parseEventNames(tsSource) {
	const block = /export const EventName = \{([\s\S]*?)\} as const/.exec(tsSource)
	if(!block) {
		throw new Error('EventName block not found: the typescript-client layout changed')
	}

	const values = [...block[1].matchAll(/^\s*\w+:\s*'([^']+)'/gm)].map(m => m[1])
	if(!values.length) {
		throw new Error('EventName block is empty: the typescript-client layout changed')
	}

	return [...new Set(values)].sort()
}

async function main() {
	const { values } = parseArgs({ options: { local: { type: 'string' }, ref: { type: 'string', default: 'main' } } })
	let scopesText, eventsText, source
	if(values.local) {
		scopesText = readFileSync(join(values.local, SCOPES_PATH), 'utf8')
		eventsText = readFileSync(join(values.local, EVENTS_PATH), 'utf8')
		const sha = execFileSync('git', ['-C', values.local, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
		source = `${REPO}@${sha}`
	} else {
		const get = async path => {
			const url = `https://raw.githubusercontent.com/${REPO}/${values.ref}/${path}`
			const res = await fetch(url)
			if(!res.ok) {
				throw new Error(`${url}: ${res.status}`)
			}

			return res.text()
		}

		;[scopesText, eventsText] = await Promise.all([get(SCOPES_PATH), get(EVENTS_PATH)])
		source = `${REPO}@${values.ref}`
	}

	const scopes = parseScopes(scopesText)
	const events = parseEventNames(eventsText)
	writeFileSync(`${dataDir}scopes.json`, `${JSON.stringify({ source, ...scopes }, null, '\t')}\n`)
	writeFileSync(`${dataDir}events.json`, `${JSON.stringify({ source, events }, null, '\t')}\n`)
	console.log(`${source}: ${scopes.known.length} scopes (${scopes.appGrantable.length} appGrantable), ${events.length} events`)
}

if(process.argv[1] === fileURLToPath(import.meta.url)) {
	await main()
}
