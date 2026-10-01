// Structured JSON lines on stdout (stderr for errors). Never log request bodies, tokens
// or signing secrets.
export const log = (level, msg, extra = {}) => {
	const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...extra })
	;(level === 'error' ? process.stderr : process.stdout).write(`${line}\n`)
}
