// create-chatdaddy-app: command dispatch. Returns an exit code, never calls process.exit.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { runDev } from './dev/repl.mjs'
import { InitError, init } from './init.mjs'
import { CATALOGUE_SOURCE, validateManifest } from './validate/index.mjs'

export const MAX_MANIFEST_BYTES = 1024 * 1024

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const USAGE = `create-chatdaddy-app ${pkg.version}

usage:
  create-chatdaddy-app init <dir> [--name "My App"]
      scaffold a working app in an empty directory
  create-chatdaddy-app validate [manifest.json]
      check a manifest the way ChatDaddy does when you publish (default: ./chatdaddy-app.json)
  create-chatdaddy-app dev [--app http://localhost:3000] [--manifest chatdaddy-app.json]
                           [--port 4100] [--key-file .chatdaddy-dev/public-key.pem]
      stand in for ChatDaddy locally: install the app, call its actions, receive its triggers`

/**
 * @param {string[]} argv arguments after the program name
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void, stdin?: NodeJS.ReadableStream }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
	const stdout = io.stdout || (s => console.log(s))
	const stderr = io.stderr || (s => console.error(s))
	const [command, ...rest] = argv
	try {
		if(!command || command === '--help' || command === '-h' || command === 'help') {
			stdout(USAGE)
			return command ? 0 : 2
		}

		if(command === '--version' || command === '-v') {
			stdout(pkg.version)
			return 0
		}

		if(command === 'init') {
			const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { name: { type: 'string' } } })
			const r = init(positionals[0], { name: values.name })
			stdout(`created ${r.appName} (id ${r.appId}) in ${positionals[0]}:\n${r.files.map(f => `  ${f}`).join('\n')}`)
			stdout(`\nnext:\n  cd ${positionals[0]}\n  npm test\n  npm run dev      (then, in another terminal: create-chatdaddy-app dev)`)
			return 0
		}

		if(command === 'validate') {
			const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} })
			const file = positionals[0] || 'chatdaddy-app.json'
			if(!existsSync(file)) {
				stderr(`${file}: not found`)
				return 2
			}

			// a manifest is a few KB: refuse anything implausibly large before reading it
			if(statSync(file).size > MAX_MANIFEST_BYTES) {
				stderr(`${file}: larger than ${MAX_MANIFEST_BYTES} bytes, not a manifest`)
				return 2
			}

			let manifest
			try {
				manifest = JSON.parse(readFileSync(file, 'utf8'))
			} catch(err) {
				stderr(`${file}: not valid JSON (${err.message})`)
				return 2
			}

			const r = validateManifest(manifest)
			if(r.valid) {
				stdout(`${file}: valid (scope and event names from ${CATALOGUE_SOURCE.scopes})`)
				return 0
			}

			stderr(`${file}: INVALID, ${r.errors.length} problem${r.errors.length === 1 ? '' : 's'}`)
			for(const e of r.errors) {
				stderr(`  ${e.message}`)
			}

			return 1
		}

		if(command === 'dev') {
			const { values } = parseArgs({
				args: rest,
				options: {
					app: { type: 'string', default: 'http://localhost:3000' },
					manifest: { type: 'string', default: 'chatdaddy-app.json' },
					port: { type: 'string', default: '4100' },
					'key-file': { type: 'string', default: '.chatdaddy-dev/public-key.pem' },
				},
			})
			const port = Number(values.port)
			if(!Number.isInteger(port) || port < 0 || port > 65535) {
				stderr('--port must be 0-65535')
				return 2
			}

			if(!existsSync(values.manifest)) {
				stderr(`${values.manifest}: not found (run from your app's directory or pass --manifest)`)
				return 2
			}

			await runDev({
				manifestPath: values.manifest, appUrl: values.app, port, keyFile: values['key-file'],
				stdin: io.stdin || process.stdin, out: stdout,
			})
			return 0
		}

		stderr(`unknown command "${command}"\n\n${USAGE}`)
		return 2
	} catch(err) {
		if(err instanceof InitError) {
			stderr(`error: ${err.message}`)
			return 1
		}

		if(err?.code?.startsWith('ERR_PARSE_ARGS')) {
			stderr(`error: ${err.message}`)
			return 2
		}

		throw err
	}
}
