#!/usr/bin/env bash
# Deploy ChatDaddy for Shopify to Fly.io. Safe to re-run: it only creates what is missing and
# never rotates a secret that is already set.
#
#   FLY_API_TOKEN=...  CHATDADDY_BOTS_URL=https://api.chatdaddy.tech/bots  SHOPIFY_CLIENT_SECRET=...  ./deploy-fly.sh
#
# Optional: FLY_APP (default chatdaddy-app-shopify), FLY_ORG, FLY_REGION (default sin).
# The token and the secrets are never printed or written to disk.
set -euo pipefail
cd "$(dirname "$0")"

: "${FLY_API_TOKEN:?FLY_API_TOKEN is required}"
: "${CHATDADDY_BOTS_URL:?CHATDADDY_BOTS_URL is required (the bots base URL)}"
: "${SHOPIFY_CLIENT_SECRET:?SHOPIFY_CLIENT_SECRET is required (the Shopify app's client secret, from the Partner dashboard)}"
APP="${FLY_APP:-chatdaddy-app-shopify}"
REGION="${FLY_REGION:-sin}"
VOLUME=shopify_data
export FLY_API_TOKEN
command -v fly >/dev/null || { echo "flyctl (fly) is not installed" >&2; exit 1; }

# `fly ... --json` output is searched for the quoted name only; no jq needed
if fly apps list --json | grep -q "\"$APP\""; then
	echo "app $APP exists"
else
	fly apps create "$APP" ${FLY_ORG:+--org "$FLY_ORG"}
fi

if fly volumes list -a "$APP" --json | grep -q "\"$VOLUME\""; then
	echo "volume $VOLUME exists"
else
	fly volumes create "$VOLUME" -a "$APP" -r "$REGION" -s 1 --yes
fi

# the client secret comes from the Shopify Partner dashboard: piped to `fly secrets import`, never echoed.
# Re-running with the same value is a no-op; a different value replaces it.
{
	echo "SHOPIFY_CLIENT_SECRET=$SHOPIFY_CLIENT_SECRET"
	echo "CHATDADDY_BOTS_URL=$CHATDADDY_BOTS_URL"
	echo "PUBLIC_URL=https://$APP.fly.dev"
} | fly secrets import -a "$APP" --stage

# --ha=false: one machine (the SQLite file has a single writer)
fly deploy -a "$APP" --config fly.toml --ha=false --yes

echo
echo "public URL (use as publish --base-url): https://$APP.fly.dev"
