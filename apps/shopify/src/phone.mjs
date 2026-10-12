// Shopify phones are free text: "+1 (555) 123-4567", "0912 345 678", "tel:+852 9123 4567",
// "0085291234567". No libphonenumber (zero dependencies): this handles the common shapes and
// returns undefined rather than guess. ponytail: a country missing from CALLING_CODES, given
// without a "+", is rejected; add it here.
const CALLING_CODES = {
	HK: '852', SG: '65', MY: '60', PH: '63', VN: '84', ID: '62', TH: '66', CN: '86', TW: '886', MO: '853',
	JP: '81', KR: '82', IN: '91', PK: '92', BD: '880', LK: '94', AE: '971', SA: '966', QA: '974', KW: '965',
	IL: '972', TR: '90', EG: '20', ZA: '27', NG: '234', KE: '254', GB: '44', IE: '353', FR: '33', DE: '49',
	ES: '34', IT: '39', NL: '31', PT: '351', US: '1', CA: '1', MX: '52', BR: '55', AR: '54', CL: '56',
	CO: '57', AU: '61', NZ: '64',
}

/**
 * @param {unknown} raw whatever Shopify sent
 * @param {...unknown} countryCodes ISO-3166 alpha-2 hints, best first (address country_code)
 * @returns {string | undefined} "+<digits>" (E.164) or undefined
 */
export function normalizePhone(raw, ...countryCodes) {
	if(typeof raw !== 'string' && typeof raw !== 'number') {
		return undefined
	}

	let s = `${raw}`.trim().replace(/^tel:/i, '')
	s = s.replace(/\s*(?:ext\.?|extension|x|#)\s*\d+$/i, '') // extension
	s = s.replace(/\(\s*0\s*\)/, '') // "+60 (0)12 ..." trunk zero written in brackets
	const plus = s.startsWith('+')
	let digits = s.replace(/\D/g, '')
	if(!digits) {
		return undefined
	}

	if(!plus && digits.startsWith('00')) {
		digits = digits.slice(2)
	} else if(!plus) {
		const cc = countryCodes.map(c => CALLING_CODES[`${c || ''}`.toUpperCase()]).find(Boolean)
		if(!cc) {
			return undefined
		}

		// already carries the country code (long enough that it cannot be a national number)
		if(!(digits.startsWith(cc) && digits.length >= cc.length + 7 && digits.length >= 10)) {
			digits = cc + digits.replace(/^0+/, '')
		}
	}

	// E.164: 8..15 digits (shortest real numbers are 8 incl. country code), no leading 0
	return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : undefined
}
