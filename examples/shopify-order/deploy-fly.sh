#!/usr/bin/env bash
# Deploy the Shopify order app to Fly.io. Safe to re-run: it only creates what is missing and
# never rotates a secret that is already set.
#
#   FLY_API_TOKEN=...  CHATDADDY_BOTS_URL=https://api.chatdaddy.tech/bots  ./deploy-fly.sh
#
# Optional: FLY_APP (default chatdaddy-app-shopify-order), FLY_ORG, FLY_REGION (default sin).
# The token and the generated secrets are never printed or written to disk.
set -euo pipefail
cd "$(dirname "$0")"

: "${FLY_API_TOKEN:?FLY_API_TOKEN is required}"
: "${CHATDADDY_BOTS_URL:?CHATDADDY_BOTS_URL is required (the bots base URL)}"
APP="${FLY_APP:-chatdaddy-app-shopify-order}"
REGION="${FLY_REGION:-sin}"
VOLUME=shopify_order_data
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

# set a generated secret ONLY if absent: piped into `fly secrets import`, so it never echoes
existing="$(fly secrets list -a "$APP" --json)"
for name in WEBHOOK_SECRET_KEY ADMIN_TOKEN; do
	if grep -q "\"$name\"" <<<"$existing"; then
		echo "secret $name already set, leaving it"
	else
		echo "$name=$(openssl rand -hex 32)" | fly secrets import -a "$APP" --stage
		echo "secret $name generated and staged"
	fi
done
# not secret, but it lives with the others so a re-run keeps one source of truth
echo "CHATDADDY_BOTS_URL=$CHATDADDY_BOTS_URL" | fly secrets import -a "$APP" --stage

# --ha=false: one machine (the store is a single-writer file)
fly deploy -a "$APP" --config fly.toml --ha=false --yes

echo
echo "public URL (use as publish --base-url): https://$APP.fly.dev"
