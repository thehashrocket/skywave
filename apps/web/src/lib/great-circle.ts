/**
 * Great-circle geometry on a spherical Earth: distance, midpoint and the path
 * between two places, for beacon mode (issue #59). A sphere is within 0.5% of
 * the ellipsoid, far finer than "1,000 to 8,000 km" needs.
 */

const RAD = Math.PI / 180;

/** Mean Earth radius (IUGG), in km. */
export const EARTH_RADIUS_KM = 6_371;

export type LatLon = { lat: number; lon: number };

function toVector({ lat, lon }: LatLon): [number, number, number] {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
}

function fromVector([x, y, z]: [number, number, number]): LatLon {
  return { lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lon: Math.atan2(y, x) / RAD };
}

/** The angle between two places seen from Earth's centre, in radians. */
function centralAngle(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How far `km` lies outside `min`..`max`, in km: 0 inside it. */
export function kmOutsideRange(km: number, min: number, max: number): number {
  if (km < min) return min - km;
  if (km > max) return km - max;
  return 0;
}

/** Short-path distance, in km (haversine). */
export function distanceKm(a: LatLon, b: LatLon): number {
  return centralAngle(a, b) * EARTH_RADIUS_KM;
}

/** The point a fraction `f` (0..1) of the way along the short path from a to b. */
export function intermediate(a: LatLon, b: LatLon, f: number): LatLon {
  const d = centralAngle(a, b);
  if (d === 0) return { ...a };
  const wa = Math.sin((1 - f) * d) / Math.sin(d);
  const wb = Math.sin(f * d) / Math.sin(d);
  const va = toVector(a);
  const vb = toVector(b);
  return fromVector([wa * va[0] + wb * vb[0], wa * va[1] + wb * vb[1], wa * va[2] + wb * vb[2]]);
}

/** The middle of the short path: where a one-hop signal reflects. */
export function midpoint(a: LatLon, b: LatLon): LatLon {
  return intermediate(a, b, 0.5);
}

/**
 * The short path from a to b as GeoJSON MultiLineString coordinates
 * ([lon, lat]), `steps` segments long, cut where it crosses ±180° so a map
 * that draws one world copy doesn't streak across the whole width.
 */
export function greatCirclePath(a: LatLon, b: LatLon, steps = 64): [number, number][][] {
  const lines: [number, number][][] = [[]];
  let prev: [number, number] | null = null;
  for (let i = 0; i <= steps; i++) {
    const p = intermediate(a, b, i / steps);
    const point: [number, number] = [p.lon, p.lat];
    if (prev && Math.abs(point[0] - prev[0]) > 180) {
      // Crossing the antimeridian: end this line at the edge, start the next at the other edge.
      const edge = prev[0] > 0 ? 180 : -180;
      const unwrapped = point[0] + (edge > 0 ? 360 : -360);
      const t = (edge - prev[0]) / (unwrapped - prev[0]);
      const lat = prev[1] + t * (point[1] - prev[1]);
      lines[lines.length - 1]!.push([edge, lat]);
      lines.push([[-edge, lat]]);
    }
    lines[lines.length - 1]!.push(point);
    prev = point;
  }
  return lines;
}
