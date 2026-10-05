// Regenerates src/data/public-suffix.json from the Public Suffix List, INCLUDING the
// private section (github.io, herokuapp.com, vercel.app, workers.dev, ...). A connection's
// host template may not use a public suffix as its fixed suffix (see src/validate/connections.mjs).
//
//   node scripts/sync-public-suffix.mjs                  fetch https://publicsuffix.org/list/public_suffix_list.dat
//   node scripts/sync-public-suffix.mjs --local <file>   read a downloaded copy instead (no network)
//
// Not run by the tests. Re-run it, and commit the result, now and then; `validate` is only as
// current as the last sync.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, domainToASCII } from 'node:url'
import { parseArgs } from 'node:util'

const LIST_URL = 'https://publicsuffix.org/list/public_suffix_list.dat'
const out = fileURLToPath(new URL('../src/data/public-suffix.json', import.meta.url))

/** Lowercase punycode form of one rule: `*.` and `!` markers kept, other labels converted. */
export function normaliseRule(rule) {
	const marker = rule.startsWith('!') ? '!' : ''
	const labels = rule.slice(marker.length).split('.').map(l => (l === '*' ? l : domainToASCII(l)))
	if(labels.some(l => !l)) {
		throw new Error(`cannot convert rule to ASCII: ${rule}`)
	}

	return marker + labels.join('.')
}

/**
 * @returns {{ version: string, commit: string, icann: string[], private: string[] }} each sorted and
 * deduplicated; `private` is the list's private section (github.io, herokuapp.com, ...)
 */
export function parsePsl(text) {
	const version = /^\/\/ VERSION: (.+)$/m.exec(text)?.[1]
	const commit = /^\/\/ COMMIT: (.+)$/m.exec(text)?.[1]
	if(!version || !commit) {
		throw new Error('VERSION/COMMIT header not found: the list layout changed')
	}

	const split = text.indexOf('// ===BEGIN PRIVATE DOMAINS===')
	if(split < 0) {
		throw new Error('private section not found: the list layout changed')
	}

	const rulesOf = part => {
		const rules = new Set()
		for(const line of part.split('\n')) {
			const rule = line.trim().split(/\s+/)[0]
			if(rule && !rule.startsWith('//')) {
				rules.add(normaliseRule(rule))
			}
		}

		return [...rules].sort()
	}

	const icann = rulesOf(text.slice(0, split))
	const priv = rulesOf(text.slice(split))
	if([...icann, ...priv].some(r => !/^[!*a-z0-9.-]+$/.test(r))) {
		throw new Error('unexpected character in a rule: the generator quotes rules without escaping')
	}

	if(icann.length < 5000 || priv.length < 1000) {
		throw new Error(`only ${icann.length} ICANN and ${priv.length} private rules parsed: the list layout changed`)
	}

	return { version, commit, icann, private: priv }
}

async function main() {
	const { values } = parseArgs({ options: { local: { type: 'string' } } })
	let text
	if(values.local) {
		text = readFileSync(values.local, 'utf8')
	} else {
		const res = await fetch(LIST_URL)
		if(!res.ok) {
			throw new Error(`${LIST_URL}: ${res.status}`)
		}

		text = await res.text()
	}

	const { version, commit, icann, private: priv } = parsePsl(text)
	const body = [
		'{',
		`\t"source": ${JSON.stringify({ url: LIST_URL, version, commit })},`,
		'\t"license": "Public Suffix List, MPL-2.0 (https://publicsuffix.org/list/); ICANN and private sections",',
		'\t"icann": [',
		icann.map(r => `\t\t${JSON.stringify(r)}`).join(',\n'),
		'\t],',
		'\t"private": [',
		priv.map(r => `\t\t${JSON.stringify(r)}`).join(',\n'),
		'\t]',
		'}',
		'',
	].join('\n')
	writeFileSync(out, body)
	console.log(`${LIST_URL} @ ${version} (${commit.slice(0, 12)}): ${icann.length} ICANN + ${priv.length} private rules`)
}

if(process.argv[1] === fileURLToPath(import.meta.url)) {
	await main()
}
