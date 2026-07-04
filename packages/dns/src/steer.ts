/**
 * Geo steering — pure, IO-free record selection (docs/product/edge-network.md).
 *
 * Given a client's estimated location (from GeoIP / EDNS Client Subnet, resolved
 * upstream) and the set of regional ingress endpoints with their health, this
 * picks the closest *healthy* targets with deterministic failover ordering.
 *
 * This is the heart of swarmy-dns per-query answering: `answerQuery` calls
 * {@link steer} for every A question against a GeoRecord. It is also reused by
 * the controller for resolution previews and by the provider-sync path. Because
 * resolution is pure it is exhaustively unit-tested.
 *
 * No external GeoIP DB is bundled here: region coordinates are a small static
 * table (the `swarmy.region` label values map to lat/lon). A GeoIP lookup, if
 * available, only converts a *client IP/subnet* → a `ClientLocation`; the
 * ranking math below is provider-agnostic.
 */

// ───────────────────────────────────────────── coordinates ──

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Canonical coordinates for well-known region labels. Unknown regions fall back
 * to {@link parseRegionCoord} (a coarse continent-prefix heuristic) so steering
 * still degrades gracefully for custom labels.
 */
export const REGION_COORDS: Record<string, LatLon> = {
  'us-east': { lat: 39.0, lon: -77.5 },
  'us-east-1': { lat: 39.0, lon: -77.5 },
  'us-west': { lat: 45.6, lon: -121.2 },
  'us-west-1': { lat: 37.4, lon: -122.1 },
  'us-central': { lat: 41.3, lon: -95.9 },
  'ca-central': { lat: 45.5, lon: -73.6 },
  'sa-east': { lat: -23.5, lon: -46.6 },
  'eu-west': { lat: 53.3, lon: -6.3 },
  'eu-west-1': { lat: 53.3, lon: -6.3 },
  'eu-central': { lat: 50.1, lon: 8.7 },
  'eu-north': { lat: 59.3, lon: 18.1 },
  'eu-south': { lat: 45.5, lon: 9.2 },
  'me-south': { lat: 26.1, lon: 50.6 },
  'af-south': { lat: -33.9, lon: 18.4 },
  'ap-south': { lat: 19.1, lon: 72.9 },
  'ap-southeast': { lat: 1.3, lon: 103.8 },
  'ap-northeast': { lat: 35.7, lon: 139.7 },
  'ap-east': { lat: 22.3, lon: 114.2 },
};

/**
 * Coarse fallback: map a region label's continent prefix to a representative
 * point so unknown labels (e.g. `ap-foo`) still rank sensibly.
 */
const CONTINENT_COORDS: Record<string, LatLon> = {
  us: { lat: 39.8, lon: -98.6 },
  ca: { lat: 56.1, lon: -106.3 },
  sa: { lat: -14.2, lon: -51.9 },
  eu: { lat: 50.0, lon: 10.0 },
  me: { lat: 26.0, lon: 50.0 },
  af: { lat: -8.8, lon: 34.5 },
  ap: { lat: 22.0, lon: 100.0 },
};

/** Best-effort coordinates for a region label. Never throws. */
export function regionCoord(region: string): LatLon | undefined {
  const key = region.trim().toLowerCase();
  if (REGION_COORDS[key]) return REGION_COORDS[key];
  return parseRegionCoord(key);
}

function parseRegionCoord(region: string): LatLon | undefined {
  const prefix = region.split('-')[0] ?? '';
  return CONTINENT_COORDS[prefix];
}

// ───────────────────────────────────────────── distance ──

const EARTH_RADIUS_KM = 6371;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle (haversine) distance in kilometres between two coordinates.
 * Symmetric, zero for identical points, monotone in angular separation.
 */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Distance between two region labels by coordinate. Returns `Infinity` when
 * either region's coordinates are unknown so it always sorts *last* (never
 * preferred over a region we can actually place).
 */
export function regionDistanceKm(from: string, to: string): number {
  const a = regionCoord(from);
  const b = regionCoord(to);
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return haversineKm(a, b);
}

// ───────────────────────────────────────────── steering ──

export interface SteerTarget {
  /** Resolved A/AAAA value or CNAME hostname. */
  target: string;
  /** The `swarmy.region` label this endpoint lives in. */
  region: string;
  /** Live health bit (persisted AND online), already composed by the caller. */
  healthy: boolean;
  /**
   * Optional static weight (higher = more preferred within a distance tier).
   * Defaults to 1. Used as a tiebreaker, never overriding distance ordering
   * across regions.
   */
  weight?: number;
}

export interface ClientLocation {
  /** Estimated client coordinates (from GeoIP / ECS). */
  coord?: LatLon;
  /** Estimated client region label, if the resolver mapped one. */
  region?: string;
}

export interface SteerInput {
  client: ClientLocation;
  targets: SteerTarget[];
  /** Max records to return (failover spread). Default 2. */
  maxAnswers?: number;
}

export interface SteerResult {
  /** Ordered answer set: closest healthy first, then failover spill. */
  answers: SteerTarget[];
  /** True when *no* healthy target existed and we spilled to unhealthy ones. */
  degraded: boolean;
  /** True when the client could not be located (ranked by region label only / arbitrary). */
  unlocated: boolean;
}

/** Resolve the client's anchor coordinates from coord, else its region label. */
function clientCoord(client: ClientLocation): LatLon | undefined {
  if (client.coord) return client.coord;
  if (client.region) return regionCoord(client.region);
  return undefined;
}

/**
 * Pick the closest healthy targets for a client, with deterministic failover.
 *
 * Ordering (stable, total):
 *   1. healthy before unhealthy (failover: unhealthy only ever spill)
 *   2. ascending great-circle distance to the client
 *   3. descending weight
 *   4. region label asc, then target asc (deterministic tiebreak)
 *
 * If every target is unhealthy we still return the best-ranked ones (better to
 * send traffic somewhere than NXDOMAIN) and flag `degraded`.
 */
export function steer(input: SteerInput): SteerResult {
  const max = Math.max(1, input.maxAnswers ?? 2);
  const anchor = clientCoord(input.client);
  const unlocated = anchor === undefined;

  const dist = (t: SteerTarget): number => {
    if (!anchor) return 0; // unlocated: distance is neutral, fall back to weight/label
    const c = regionCoord(t.region);
    return c ? haversineKm(anchor, c) : Number.POSITIVE_INFINITY;
  };

  const ranked = [...input.targets].sort((a, b) => {
    // 1. healthy first
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    // 2. distance asc
    const da = dist(a);
    const db = dist(b);
    if (da !== db) return da - db;
    // 3. weight desc
    const wa = a.weight ?? 1;
    const wb = b.weight ?? 1;
    if (wa !== wb) return wb - wa;
    // 4. deterministic tiebreak
    if (a.region !== b.region) return a.region < b.region ? -1 : 1;
    return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
  });

  const healthy = ranked.filter((t) => t.healthy);
  const degraded = healthy.length === 0 && ranked.length > 0;
  const pool = degraded ? ranked : healthy;

  return { answers: pool.slice(0, max), degraded, unlocated };
}
