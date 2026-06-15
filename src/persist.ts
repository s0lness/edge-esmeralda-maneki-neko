/**
 * GCS snapshot persistence for Cloud Run, zero dependencies: tokens come from the
 * metadata server (only present on GCP), objects move via the JSON API. If
 * MANEKI_GCS_BUCKET is unset or we're not on GCP, this is a no-op and the local
 * JSON file is the only store (fine for dev/tests).
 *
 * Model: restore once at boot (object -> local file), then debounce-upload the
 * file after every save. Last-writer-wins; with min-instances=1 in one region
 * that is acceptable for this experiment.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BUCKET = process.env.MANEKI_GCS_BUCKET;
const OBJECT = process.env.MANEKI_GCS_OBJECT ?? "maneki.db.json";

async function gcpToken(): Promise<string | null> {
  try {
    const r = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) },
    );
    if (!r.ok) return null;
    return ((await r.json()) as { access_token: string }).access_token;
  } catch {
    return null;
  }
}

/** Pull the snapshot into the local db file at boot. Returns true if restored. */
export async function restore(localPath: string): Promise<boolean> {
  if (!BUCKET) return false;
  const token = await gcpToken();
  if (!token) return false;
  try {
    const r = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(OBJECT)}?alt=media`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return false; // first boot: no snapshot yet
    writeFileSync(localPath, await r.text());
    console.log(`[persist] restored ${OBJECT} from gs://${BUCKET}`);
    return true;
  } catch (e) {
    console.error("[persist] restore failed:", e);
    return false;
  }
}

let timer: NodeJS.Timeout | null = null;

/** Debounced upload of the local db file. Call after every save. */
export function scheduleUpload(localPath: string) {
  if (!BUCKET) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    const token = await gcpToken();
    if (!token || !existsSync(localPath)) return;
    try {
      const r = await fetch(
        `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(OBJECT)}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: readFileSync(localPath, "utf8"),
        },
      );
      if (!r.ok) console.error(`[persist] upload failed: ${r.status} ${await r.text()}`);
    } catch (e) {
      console.error("[persist] upload failed:", e);
    }
  }, 2000);
  timer.unref?.();
}
