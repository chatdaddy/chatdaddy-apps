// Flow actions this app serves (declared in chatdaddy-app.json). Each is async and gets
// ({ input, settings, installationId, proxy }); it returns { output } or { error }.
import { normalizePhone } from './phone.mjs'
import { checkoutStatus, latestOrderByPhone } from './queries.mjs'

const s = v => (typeof v === 'string' || typeof v === 'number' ? `${v}`.trim() : '')

export const ACTIONS = {
	/** the cart flow's condition: is this checkout still open (not completed)? */
	async 'is-checkout-open'({ input, installationId, proxy }) {
		const checkoutId = s(input?.checkoutId)
		if(!/^\d{1,20}$/.test(checkoutId)) {
			return { error: 'checkoutId is required (the numeric id from the trigger)' }
		}

		const { isOpen, checkoutUrl } = await checkoutStatus(proxy, installationId, checkoutId)
		return { output: { isOpen, checkoutUrl } }
	},

	/** "where is my order": the contact's latest order, by phone */
	async 'get-latest-order-for-contact'({ input, installationId, proxy }) {
		const phone = normalizePhone(s(input?.phone), s(input?.countryCode))
		if(!phone) {
			return { error: 'phone is required, in international format (+...)' }
		}

		const order = await latestOrderByPhone(proxy, installationId, phone)
		return { output: order ? { found: true, ...order } : { found: false } }
	},
}
