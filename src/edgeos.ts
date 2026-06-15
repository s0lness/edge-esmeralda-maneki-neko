/**
 * EdgeOS catalog client. The API key (eos_live_...) is scoped to "event
 * automation routes": we can read the EVENT SCHEDULE and VENUES, but NOT the
 * attendee list (that needs a per-user portal session, 403 otherwise). So we
 * use EdgeOS only to propose REAL rendezvous points; presence is self-declared.
 */
const BASE = "https://api.edgeos.world/api/v1";
const KEY = () => process.env.EDGEOS_API_KEY ?? "";
const POPUP = () => process.env.EDGEOS_POPUP_ID ?? "";

export interface EdgeEvent {
  id: string;
  title: string;
  startsAt: string; // ISO
  endsAt: string;
  venue: string;
  location: string;
  track?: string;
}

async function get(path: string): Promise<unknown> {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${KEY()}` }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`edgeos ${r.status} on ${path}`);
  return r.json();
}

function arr(d: unknown): Record<string, unknown>[] {
  if (Array.isArray(d)) return d as Record<string, unknown>[];
  const o = d as Record<string, unknown>;
  for (const k of ["results", "data", "events", "items"]) if (Array.isArray(o?.[k])) return o[k] as Record<string, unknown>[];
  return [];
}

export interface EdgeParticipant {
  profileId: string;
  firstName: string;
  lastName: string;
  status: string;       // e.g. accepted / registered
  role: string;
}

/** Who is registered for one event. Used to pair co-located players and to pick
 *  a real rendezvous. Names only (no telegram handle), so we join to a Maneki
 *  player by name at /join time. */
export async function eventParticipants(eventId: string): Promise<EdgeParticipant[]> {
  if (!KEY()) return [];
  // The endpoint paginates: { paging: { limit, offset, total } }, offset via `skip`.
  // Page through until we've pulled `total`, else we silently see only the first ~95.
  const out: EdgeParticipant[] = [];
  const limit = 200;
  for (let skip = 0, guard = 0; guard < 100; guard++) {
    const d = await get(`/event-participants/portal/participants?event_id=${eventId}&limit=${limit}&skip=${skip}`);
    const rows = arr(d);
    for (const p of rows) out.push({
      profileId: String(p.profile_id ?? ""),
      firstName: String(p.first_name ?? ""),
      lastName: String(p.last_name ?? ""),
      status: String(p.status ?? ""),
      role: String(p.role ?? ""),
    });
    const paging = (d as { paging?: { total?: number } }).paging;
    const total = Number(paging?.total ?? out.length);
    skip += rows.length;
    if (!rows.length || skip >= total) break;
  }
  return out;
}

/** Normalize a name for fuzzy join between EdgeOS records and Maneki handles. */
export const nameKey = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").trim();

/** Upcoming published events, soonest first. The pool of real rendezvous points. */
export async function upcomingEvents(afterIso = new Date().toISOString(), limit = 40): Promise<EdgeEvent[]> {
  if (!KEY()) return [];
  const d = await get(`/events/portal/events?popup_id=${POPUP()}&event_status=published&start_after=${encodeURIComponent(afterIso)}&limit=${limit}`);
  return arr(d)
    .map((e) => ({
      id: String(e.id),
      title: String(e.title ?? e.name ?? "an event"),
      startsAt: String(e.start_time ?? ""),
      endsAt: String(e.end_time ?? ""),
      venue: String(e.venue_title ?? e.custom_location_name ?? ""),
      location: String(e.venue_location ?? e.custom_location_url ?? ""),
      track: e.track_title ? String(e.track_title) : undefined,
    }))
    .filter((e) => e.startsAt)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
