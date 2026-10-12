// Webhook bodies in Shopify's REST-style JSON (what webhook subscriptions deliver). Shapes are
// from memory of shopify.dev's webhook reference, trimmed to the fields the app reads: ASSUMED,
// not captured from a real shop. Replace with captured payloads at the first real install.
export const ORDER = {
	id: 820982911946, name: '#1001', order_number: 1001, currency: 'HKD', subtotal_price: '380.00', total_price: '410.00',
	financial_status: 'pending', contact_email: 'ada@example.com', phone: null,
	payment_gateway_names: ['Cash on Delivery (COD)'], order_status_url: 'https://shop.example/1/orders/abc/authenticate',
	customer: {
		first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: null, accepts_marketing: false,
		sms_marketing_consent: { state: 'subscribed' }, default_address: { phone: '9123 4567', country_code: 'HK' },
	},
	shipping_address: { first_name: 'Ada', last_name: 'Lovelace', phone: '', country_code: 'HK' },
	line_items: [{ title: 'Shirt', quantity: 2 }, { title: 'Hat', quantity: 1 }],
}

export const FULFILLMENT = {
	id: 255858046, order_id: 820982911946, status: 'success', name: '#1001.1', email: 'ada@example.com',
	tracking_company: 'SF Express', tracking_number: 'SF123456789', tracking_numbers: ['SF123456789'],
	tracking_url: 'https://sf.example/track/SF123456789', tracking_urls: ['https://sf.example/track/SF123456789'],
	shipment_status: null,
	destination: { first_name: 'Ada', last_name: 'Lovelace', phone: '+852 9123 4567', country_code: 'HK' },
	line_items: [{ title: 'Shirt', quantity: 2 }],
}

export const DELIVERED = { ...FULFILLMENT, shipment_status: 'delivered' }

export const CHECKOUT = {
	id: 9988776655, token: 'tok123', completed_at: null, currency: 'HKD', total_price: '410.00',
	abandoned_checkout_url: 'https://shop.example/1/checkouts/tok123/recover?key=k', email: 'ada@example.com',
	phone: '+85291234567', buyer_accepts_marketing: true,
	customer: { first_name: 'Ada', last_name: 'Lovelace' },
	shipping_address: { country_code: 'HK' },
	line_items: [{ title: 'Shirt', quantity: 2 }],
}
