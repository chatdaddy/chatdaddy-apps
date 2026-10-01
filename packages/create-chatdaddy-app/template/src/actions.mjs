// Flow actions this app serves. Each key is an action id declared in chatdaddy-app.json.
// A handler gets the flow's `input` and the installation's `settings` and returns
// `{ output }` (an object with the declared outputProperties) or `{ error }` (answered
// with HTTP 400 and shown to the flow author).
export const ACTIONS = {
	/** example: upper-cases some text */
	shout(input) {
		const text = typeof input?.text === 'string' ? input.text.trim() : ''
		if(!text) {
			return { error: 'text is required' }
		}

		const result = text.toUpperCase()
		return { output: { result, length: result.length } }
	},
}
