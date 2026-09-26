import { Vec3 } from "../types";
import { WORLD } from "../config";

/** Deterministic 2D value noise from integer lattice hashes. */
function hash2(ix: number, iz: number, seed: number): number {
  let h = seed ^ Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

export function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2.02;
  }
  return sum / norm;
}

export interface CanyonSpec {
  /** polyline waypoints (x,z) */
  pts: { x: number; z: number }[];
  /** flat floor half-width, m */
  inner: number;
  /** distance over which walls rise to plateau */
  outer: number;
  /** floor depth (positive meters below surface) */
  floorDepth: number;
}

function distToPolyline(x: number, z: number, pts: { x: number; z: number }[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i].x;
    const az = pts[i].z;
    const bx = pts[i + 1].x;
    const bz = pts[i + 1].z;
    const abx = bx - ax;
    const abz = bz - az;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 0 ? ((x - ax) * abx + (z - az) * abz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + abx * t;
    const pz = az + abz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

export interface Basin {
  x: number;
  z: number;
  r: number;
  depth: number;
}

export class Terrain {
  readonly seed: number;
  /** plateau base depth (m, positive down) */
  private plateauDepth = 95;
  canyons: CanyonSpec[] = [];
  basins: Basin[] = [];

  constructor(seed: number) {
    this.seed = seed | 0;
  }

  /** Depth of the seabed below the surface in meters (positive). */
  depthAt(x: number, z: number): number {
    const H = WORLD.HALF;
    if (x < -H || x > H || z < -H || z > H) return this.plateauDepth;

    // Base plateau with rolling relief, gently deepening to the east.
    let depth = this.plateauDepth + (fbm(x * 0.0016, z * 0.0016, this.seed) - 0.5) * 55;
    depth += ((x + H) / (2 * H)) * 55; // eastward slope
    depth += (fbm(x * 0.0055, z * 0.0055, this.seed + 7) - 0.5) * 18;

    // Basins: smooth broad depressions.
    for (const b of this.basins) {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < b.r) {
        const t = smooth(Math.min(1, Math.max(0, 1 - d / b.r)));
        depth = depth + (b.depth - depth) * t;
      }
    }

    // Canyons: carved channels with sheer walls.
    for (const c of this.canyons) {
      const d = distToPolyline(x, z, c.pts);
      if (d < c.outer) {
        const floor = c.floorDepth + (fbm(x * 0.01, z * 0.01, this.seed + 31) - 0.5) * 14;
        let t: number;
        if (d <= c.inner) t = 0;
        else t = smooth((d - c.inner) / (c.outer - c.inner));
        const carved = floor + (depth - floor) * t;
        if (carved > depth) depth = carved;
      }
    }

    // World edge: rise into an impassable rim.
    const edge = Math.max(Math.abs(x), Math.abs(z));
    if (edge > H - 120) {
      const t = smooth((edge - (H - 120)) / 120);
      depth = depth * (1 - t) + 18 * t;
    }
    return Math.max(8, depth);
  }

  /** Seabed y coordinate (negative = below surface). */
  seabedY(x: number, z: number): number {
    return -this.depthAt(x, z);
  }

  waterColumn(x: number, z: number): number {
    return this.depthAt(x, z);
  }

  /**
   * Line-of-sight check: true if terrain rises above the segment a→b anywhere.
   * Samples the heightfield at fixed intervals.
   */
  losBlocked(a: Vec3, b: Vec3): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const steps = Math.max(2, Math.ceil(len / 24));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      const y = a.y + dy * t;
      if (this.seabedY(x, z) > y + 2) return true;
    }
    return false;
  }
}
