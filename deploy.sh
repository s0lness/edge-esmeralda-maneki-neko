#!/usr/bin/env bash
# One-command deploy of the maneki coordinator to Cloud Run.
# Run where gcloud is installed and authed (Cloud Shell, WSL, or a Mac/Linux box).
#
#   PROJECT=my-gcp-project REGION=us-west1 ADMIN_TOKEN=$(openssl rand -hex 16) ./deploy.sh
#
# Reads EDGEOS_API_KEY and EDGEOS_POPUP_ID from .env if not already in the env.
set -euo pipefail

[ -f .env ] && set -a && . ./.env && set +a

: "${PROJECT:?set PROJECT to your GCP project id}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-maneki}"
: "${EDGEOS_API_KEY:?set EDGEOS_API_KEY (or put it in .env)}"
: "${EDGEOS_POPUP_ID:?set EDGEOS_POPUP_ID (or put it in .env)}"
: "${ADMIN_TOKEN:?set ADMIN_TOKEN (e.g. ADMIN_TOKEN=\$(openssl rand -hex 16))}"

gcloud config set project "$PROJECT" >/dev/null

# Store the EdgeOS key in Secret Manager (create once, then add new versions).
if ! gcloud secrets describe edgeos-api-key >/dev/null 2>&1; then
  printf '%s' "$EDGEOS_API_KEY" | gcloud secrets create edgeos-api-key --data-file=- --replication-policy=automatic
else
  printf '%s' "$EDGEOS_API_KEY" | gcloud secrets versions add edgeos-api-key --data-file=-
fi

# State persists to GCS (MANEKI_GCS_BUCKET); keep one instance so writes don't race.
# --set-env-vars REPLACES the whole list, so every var must be present here.
ENVS="EDGEOS_POPUP_ID=${EDGEOS_POPUP_ID},ADMIN_TOKEN=${ADMIN_TOKEN},TICK_MIN=3"
[ -n "${MANEKI_GCS_BUCKET:-}" ] && ENVS="${ENVS},MANEKI_GCS_BUCKET=${MANEKI_GCS_BUCKET}"

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --set-secrets "EDGEOS_API_KEY=edgeos-api-key:latest" \
  --set-env-vars "$ENVS"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo ""
echo "maneki is live at: $URL"
echo "ADMIN_TOKEN (save this, it is how you call /admin/*): $ADMIN_TOKEN"
echo ""
echo "Next: replace https://MANEKI_HOST with $URL in SKILL.md, run npm run sync:skill,"
echo "then commit + push + bump the plugin version. Seed founders with:"
echo "  curl -s -X POST $URL/admin/seed -H \"x-admin-token: \$ADMIN_TOKEN\" -H 'content-type: application/json' \\"
echo "    -d '{\"founders\":[{\"handle\":\"sylve\",\"edgeosName\":\"<Edge name>\"}]}'"
