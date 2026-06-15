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
REGION="${REGION:-us-west1}"
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

# Single warm instance keeps the file-based store alive between requests. Swap to
# a GCS-backed store before scaling past one instance (see DESIGN, persistence).
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --set-secrets "EDGEOS_API_KEY=edgeos-api-key:latest" \
  --set-env-vars "EDGEOS_POPUP_ID=${EDGEOS_POPUP_ID},ADMIN_TOKEN=${ADMIN_TOKEN},TICK_MIN=3"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo ""
echo "maneki is live at: $URL"
echo "Next: replace https://MANEKI_HOST with $URL in skills/maneki/SKILL.md, then commit + push + bump the plugin version."
