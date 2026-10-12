import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapCheckout, mapFulfillment, mapOrder, pickPhone } from '../src/shopify.mjs'
import { CHECKOUT, DELIVERED, FULFILLMENT, ORDER } from './fixtures.mjs'

test('orders/create -> order-created payload', () => {
	assert.deepEqual(mapOrder(ORDER).payload, {
		orderId: '820982911946', orderNumber: '#1001', customerName: 'Ada Lovelace', phone: '+85291234567',
		email: 'ada@example.com', itemsSummary: '2 x Shirt, 1 x Hat', itemCount: 3, subtotal: '380.00', total: '410.00',
		currency: 'HKD', paymentGateway: 'Cash on Delivery (COD)', isCod: true, financialStatus: 'pending',
		orderStatusUrl: 'https://shop.example/1/orders/abc/authenticate', marketingConsent: true,
	})
})

test('order phone falls back across fields and uses another address for the country hint', () => {
	const o = { ...ORDER, customer: { ...ORDER.customer, default_address: { phone: '' } }, billing_address: { phone: '91234567', country_code: 'HK' } }
	assert.equal(mapOrder(o).payload.phone, '+85291234567')
	const sameCountry = { ...ORDER, customer: { ...ORDER.customer, default_address: { phone: '91234567' } }, shipping_address: { country_code: 'HK' } }
	assert.equal(mapOrder(sameCountry).payload.phone, '+85291234567')
})

test('an order with no usable phone, or no id, is skipped with a reason', () => {
	assert.deepEqual(mapOrder({ ...ORDER, customer: { first_name: 'A' }, shipping_address: {} }), { skip: 'no usable phone number' })
	assert.deepEqual(mapOrder({ ...ORDER, phone: 'n/a', customer: { phone: '12' }, shipping_address: {} }), { skip: 'no usable phone number' })
	assert.deepEqual(mapOrder({ customer: ORDER.customer }), { skip: 'no order id' })
	assert.deepEqual(mapOrder(null), { skip: 'no order id' })
})

test('marketing consent is false without any opt-in signal', () => {
	const o = { ...ORDER, customer: { ...ORDER.customer, sms_marketing_consent: { state: 'unsubscribed' } } }
	assert.equal(mapOrder(o).payload.marketingConsent, false)
})

test('fulfillments/create -> order-fulfilled payload with tracking', () => {
	assert.deepEqual(mapFulfillment(FULFILLMENT).payload, {
		orderId: '820982911946', orderNumber: '#1001', fulfillmentId: '255858046', customerName: 'Ada Lovelace',
		phone: '+85291234567', email: 'ada@example.com', itemsSummary: '2 x Shirt', trackingCompany: 'SF Express',
		trackingNumber: 'SF123456789', trackingUrl: 'https://sf.example/track/SF123456789', shipmentStatus: '',
	})
	assert.equal(mapFulfillment(DELIVERED).payload.shipmentStatus, 'delivered')
})

test('tracking falls back to the arrays', () => {
	const f = { ...FULFILLMENT, tracking_number: null, tracking_url: null }
	const p = mapFulfillment(f).payload
	assert.equal(p.trackingNumber, 'SF123456789')
	assert.equal(p.trackingUrl, 'https://sf.example/track/SF123456789')
})

test('fulfillment without a phone asks for an order lookup, which can supply it', () => {
	const f = { ...FULFILLMENT, destination: { first_name: 'Ada', phone: null, country_code: 'HK' } }
	const miss = mapFulfillment(f)
	assert.equal(miss.skip, 'no usable phone number')
	assert.equal(miss.needsOrderLookup, true)
	assert.equal(mapFulfillment(f, { orderPhone: '+85291234567' }).payload.phone, '+85291234567')
	assert.equal(mapFulfillment(f, { orderPhone: '' }).needsOrderLookup, false) // looked up, still nothing
})

test('checkouts -> checkout-abandoned payload with url and consent', () => {
	assert.deepEqual(mapCheckout(CHECKOUT).payload, {
		checkoutId: '9988776655', customerName: 'Ada Lovelace', phone: '+85291234567', email: 'ada@example.com',
		checkoutUrl: 'https://shop.example/1/checkouts/tok123/recover?key=k', itemsSummary: '2 x Shirt',
		total: '410.00', currency: 'HKD', marketingConsent: true,
	})
	assert.equal(mapCheckout({ ...CHECKOUT, buyer_accepts_marketing: false }).payload.marketingConsent, false)
})

test('completed, phoneless and urlless checkouts are skipped', () => {
	assert.equal(mapCheckout({ ...CHECKOUT, completed_at: '2026-10-12T10:00:00Z' }).skip, 'checkout already completed')
	assert.equal(mapCheckout({ ...CHECKOUT, phone: null }).skip, 'no usable phone number')
	assert.equal(mapCheckout({ ...CHECKOUT, abandoned_checkout_url: null }).skip, 'no checkout url')
})

test('pickPhone skips junk and keeps the best first', () => {
	assert.equal(pickPhone([{ phone: 'x' }, { phone: '+85291234567' }, { phone: '+14155550123' }]), '+85291234567')
	assert.equal(pickPhone([]), undefined)
})
