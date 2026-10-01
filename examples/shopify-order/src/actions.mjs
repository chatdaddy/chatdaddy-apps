// Flow actions this app serves (declared in chatdaddy-app.json).
export const ACTIONS = {
	/** pure formatter: no outbound calls, no ChatDaddy API use */
	'format-order-message'(input, settings) {
		const s = v => (typeof v === 'string' || typeof v === 'number' ? `${v}`.trim() : '')
		const name = s(input?.customerName) || 'there'
		const orderId = s(input?.orderId)
		if(!orderId) {
			return { error: 'orderId is required' }
		}

		const total = [s(input?.total), s(input?.currency)].filter(Boolean).join(' ')
		const store = s(settings?.storeName)
		const lines = [
			`Hi ${name}, thanks for your order${store ? ` at ${store}` : ''}!`,
			`Order #${orderId}${total ? ` - total ${total}` : ''}`,
		]
		if(s(input?.itemsSummary)) {
			lines.push(`Items: ${s(input.itemsSummary)}`)
		}

		return { output: { message: lines.join('\n') } }
	},
}
