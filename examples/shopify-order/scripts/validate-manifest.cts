// Run from the appstore checkout (read-only), which supplies ajv + @chatdaddy/client:
//   cd <appstore> && node -r @swc-node/register <this file> <manifest.json>
import { readFileSync } from 'node:fs'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateManifest } = require(`${process.cwd()}/src/app-manifest`)

const result = validateManifest(JSON.parse(readFileSync(process.argv[2], 'utf8')))
console.log(JSON.stringify(result, null, 2))
process.exit(result.valid ? 0 : 1)
