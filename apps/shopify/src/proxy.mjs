// The Shopify side of every call goes through ChatDaddy's connection proxy, so this app never
// holds the Shopify access token. The interface (what the rest of the app depends on):
//
//   proxy.graphql({ installationId, query, variables }) -> Promise<{ data?, errors? }>
//
// i.e. one Shopify Admin GraphQL call for the installation's `shopify` connection (public apps
// must use GraphQL, not REST). Throws on transport / non-2xx. The real client lands with the
// platform's oauth proxy path (P5 A-5); until then main.mjs uses `unavailableProxy`, and tests
// use a fake.

export class ProxyError extends Error {}

export const unavailableProxy = {
	async graphql() {
		throw new ProxyError('connection proxy is not available yet (P5 A-5)')
	},
}

/** run a query and fail on GraphQL-level errors; returns `data` */
export async function gql(proxy, installationId, query, variables) {
	const res = await proxy.graphql({ installationId, query, variables })
	if(res?.errors?.length) {
		throw new ProxyError(`shopify graphql error: ${res.errors.map(e => e.message).join('; ').slice(0, 300)}`)
	}

	return res?.data ?? {}
}
