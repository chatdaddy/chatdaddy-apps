// Flow actions this app serves. Each key is an action id declared in chatdaddy-app.json.
// A handler gets the flow's `input` and the installation's `settings` and returns
// `{ output }` (an object with the declared outputProperties) or `{ error }` (answered
// with HTTP 400). ChatDaddy treats a 400 as the flow's input being refused, so it does
// not count against your app's health; the flow sees a generic "app call failed", not
// your error text, so log anything you need to debug it.
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
