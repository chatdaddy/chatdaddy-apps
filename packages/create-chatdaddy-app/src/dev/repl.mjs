// The `dev` command: starts the local trigger endpoint, writes the dev public key,
// installs the app, then reads commands (a REPL on a terminal; one command per line when
// piped, and it exits when stdin ends).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { DevError, createDevSession } from './session.mjs'
import { createTriggerServer } from './trigger-server.mjs'

export const HELP = `commands:
  call <actionId> [--input '<json>'] [--settings '<json>']   run an action as ChatDaddy would
  handshake                                                  (re)install the app
  triggers                                                   list the triggers received so far
  help                                                       this text
  quit                                                       stop (Ctrl-D works too)`

/** shell-ish split: whitespace separates, '...' and "..." group, no escapes inside '...' */
export function tokenize(line) {
	const out = []
	let cur = ''
	let quote = null
	let has = false
	for(let i = 0; i < line.length; i++) {
		const c = line[i]
		if(quote) {
			if(c === quote) {
				quote = null
			} else if(c === '\\' && quote === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
				cur += line[++i]
			} else {
				cur += c
			}
		} else if(c === '\'' || c === '"') {
			quote = c
			has = true
		} else if(/\s/.test(c)) {
			if(cur || has) {
				out.push(cur)
				cur = ''
				has = false
			}
		} else {
			cur += c
		}
	}

	if(quote) {
		throw new DevError('unterminated quote')
	}

	if(cur || has) {
		out.push(cur)
	}

	return out
}

const parseJsonFlag = (value, flag) => {
	try {
		return JSON.parse(value)
	} catch{
		throw new DevError(`${flag} is not valid JSON: ${value}`)
	}
}

/** Runs one command line. Exported so the REPL logic is testable without a terminal. */
export async function runCommand(session, line, out) {
	const [cmd, ...args] = tokenize(line)
	if(!cmd) {
		return true
	}

	if(cmd === 'quit' || cmd === 'exit') {
		return false
	}

	if(cmd === 'help') {
		out(HELP)
	} else if(cmd === 'handshake') {
		await session.handshake()
		out(`installed: handshake accepted, ack verified (installation ${session.installationId})`)
	} else if(cmd === 'triggers') {
		out(session.fired.length
			? session.fired.map(f => `${f.triggerId} event ${f.eventId} ${JSON.stringify(f.payload)}`).join('\n')
			: 'no triggers received yet')
	} else if(cmd === 'call') {
		const [actionId, ...flags] = args
		if(!actionId) {
			throw new DevError('usage: call <actionId> [--input \'<json>\'] [--settings \'<json>\']')
		}

		let input = {}
		let settings = {}
		for(let i = 0; i < flags.length; i += 2) {
			if(flags[i] === '--input') {
				input = parseJsonFlag(flags[i + 1] ?? '', '--input')
			} else if(flags[i] === '--settings') {
				settings = parseJsonFlag(flags[i + 1] ?? '', '--settings')
			} else {
				throw new DevError(`unknown flag ${flags[i]}`)
			}
		}

		const r = await session.call(actionId, input, { settings })
		out(`${r.status} ${JSON.stringify(r.body)}`)
		for(const w of r.warnings) {
			out(`  warning: ${w}`)
		}

		for(const p of r.problems) {
			out(`  PROBLEM: ${p}`)
		}

		out(r.ok ? 'OK: response matches outputProperties' : 'FAILED')
	} else {
		throw new DevError(`unknown command "${cmd}". Type help.`)
	}

	return true
}

/**
 * @param {object} o
 * @param {string} o.manifestPath
 * @param {string} o.appUrl
 * @param {number} o.port trigger endpoint port (0 = any free port)
 * @param {string} o.keyFile where the dev PUBLIC key is written
 * @param {NodeJS.ReadableStream} o.stdin
 * @param {(line: string) => void} o.out
 */
export async function runDev({ manifestPath, appUrl, port, keyFile, stdin, out }) {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
	const session = createDevSession({ manifest, appUrl })
	const keyPath = resolve(keyFile)
	mkdirSync(dirname(keyPath), { recursive: true })
	// a PUBLIC key (the private one never leaves memory), so world-readable is fine and explicit
	writeFileSync(keyPath, session.publicKeyPem, { mode: 0o644 })

	const triggers = createTriggerServer({ session, log: out })
	const boundPort = await triggers.listen(port)
	out(`dev public key written to ${keyFile}`)
	out(`start the app with:  CHATDADDY_DEV_PUBLIC_KEY_FILE=${keyFile} CHATDADDY_BOTS_URL=http://127.0.0.1:${boundPort}  (NODE_ENV must not be production)`)
	out(`local trigger endpoint: http://127.0.0.1:${boundPort}/apps/triggers/${session.installationId}/<triggerId>`)
	try {
		await session.handshake()
		out(`installed ${manifest.id}: handshake accepted, ack verified`)
	} catch(err) {
		// any failure here is reported, never a crash: the developer fixes the app and retries
		out(`handshake failed: ${err instanceof DevError ? err.message : `unexpected error: ${err?.message || err}`}`)
		out('fix the app, then run `handshake`')
	}

	out('type help for commands')
	const rl = createInterface({ input: stdin })
	try {
		for await (const line of rl) {
			try {
				if(!await runCommand(session, line, out)) {
					break
				}
			} catch(err) {
				if(!(err instanceof DevError)) {
					throw err
				}

				out(`error: ${err.message}`)
			}
		}
	} finally {
		rl.close()
		await triggers.close()
	}

	return session
}
