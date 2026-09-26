import { Vec3, vec3 } from "../types";
import { WORLD } from "../config";
import { Terrain } from "../world/terrain";

const CELL = WORLD.NAV_CELL;
const MIN_COLUMN = 42;

export type DangerField = (x: number, z: number) => number;
export interface RouteConstraints {
  blocked?: (x: number, z: number) => boolean;
}

/**
 * Grid A* over navigable (x, z) columns derived from the terrain
 * heightfield, plus local smoothing. Depth is chosen per waypoint.
 */
export class Navigator {
  private terrain: Terrain;
  private n: number;
  private pass: Uint8Array;
  private depth: Float32Array;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    const H = WORLD.HALF;
    this.n = Math.floor((2 * H) / CELL);
    this.pass = new Uint8Array(this.n * this.n);
    this.depth = new Float32Array(this.n * this.n);
    for (let iz = 0; iz < this.n; iz++) {
      for (let ix = 0; ix < this.n; ix++) {
        const x = -H + (ix + 0.5) * CELL;
        const z = -H + (iz + 0.5) * CELL;
        const d = terrain.depthAt(x, z);
        this.depth[iz * this.n + ix] = d;
        this.pass[iz * this.n + ix] = d >= MIN_COLUMN ? 1 : 0;
      }
    }
  }

  private toCell(v: number): number {
    const H = WORLD.HALF;
    return Math.max(0, Math.min(this.n - 1, Math.floor((v + H) / CELL)));
  }

  private cellCenter(ix: number, iz: number): { x: number; z: number } {
    const H = WORLD.HALF;
    return { x: -H + (ix + 0.5) * CELL, z: -H + (iz + 0.5) * CELL };
  }

  /** Preferred cruise y at (x,z): mid-water biased toward the cruise band. */
  cruiseY(x: number, z: number, preferredDepth: number): number {
    const d = this.terrain.depthAt(x, z);
    const top = WORLD.SURFACE_MARGIN;
    const bottom = d - WORLD.SEABED_MARGIN;
    if (bottom <= top) return -Math.max(6, d * 0.5);
    const want = Math.min(Math.max(preferredDepth, top), bottom);
    return -want;
  }

  /** Nearest passable cell to a world position (spiral search). */
  private nearestPassable(ix: number, iz: number, constraints?: RouteConstraints): number {
    const n = this.n;
    const idx = (x: number, z: number) => z * n + x;
    const allowed = (x: number, z: number) => {
      const i = idx(x, z);
      if (!this.pass[i]) return false;
      const p = this.cellCenter(x, z);
      return !constraints?.blocked?.(p.x, p.z);
    };
    if (allowed(ix, iz)) return idx(ix, iz);
    for (let r = 1; r < n; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = ix + dx;
          const z = iz + dz;
          if (x < 0 || z < 0 || x >= n || z >= n) continue;
          if (allowed(x, z)) return idx(x, z);
        }
      }
    }
    return -1;
  }

  /** True when a straight line stays over navigable water. */
  private lineClear(ax: number, az: number, bx: number, bz: number, constraints?: RouteConstraints): boolean {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(len / (CELL * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (this.terrain.depthAt(x, z) < MIN_COLUMN) return false;
      if (constraints?.blocked?.(x, z)) return false;
    }
    return true;
  }

  /**
   * A* path from → to. `danger` adds traversal cost (0 = neutral).
   * Returns smoothed world waypoints (excluding start), or null.
   */
  findPath(from: Vec3, to: Vec3, danger?: DangerField, preferredDepth: number = WORLD.CRUISE_DEPTH, constraints?: RouteConstraints): Vec3[] | null {
    const n = this.n;
    const idx = (x: number, z: number) => z * n + x;
    const start = this.nearestPassable(this.toCell(from.x), this.toCell(from.z), constraints);
    const goal = this.nearestPassable(this.toCell(to.x), this.toCell(to.z), constraints);
    if (start < 0 || goal < 0) return null;
    if (start === goal) {
      return [vec3(to.x, this.cruiseY(to.x, to.z, preferredDepth), to.z)];
    }

    const g = new Float32Array(n * n).fill(Infinity);
    const parent = new Int32Array(n * n).fill(-1);
    const closed = new Uint8Array(n * n);
    const gx = goal % n;
    const gz = Math.floor(goal / n);
    const h = (i: number) => {
      const dx = Math.abs((i % n) - gx);
      const dz = Math.abs(Math.floor(i / n) - gz);
      return CELL * (Math.max(dx, dz) + 0.4142 * Math.min(dx, dz));
    };
    // Simple binary-heap-free open list (grid is small).
    const open: number[] = [start];
    g[start] = 0;
    const fScore = new Float32Array(n * n).fill(Infinity);
    fScore[start] = h(start);

    let guard = 0;
    while (open.length && guard++ < 20000) {
      let bi = 0;
      let bf = fScore[open[0]];
      for (let i = 1; i < open.length; i++) {
        if (fScore[open[i]] < bf) {
          bf = fScore[open[i]];
          bi = i;
        }
      }
      const cur = open.splice(bi, 1)[0];
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % n;
      const cz = Math.floor(cur / n);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          const ni = idx(nx, nz);
          if (!this.pass[ni] || closed[ni]) continue;
          const cc = this.cellCenter(nx, nz);
          if (constraints?.blocked?.(cc.x, cc.z)) continue;
          // no corner cutting through blocked cells
          if (dx !== 0 && dz !== 0) {
            if (!this.pass[idx(cx + dx, cz)] || !this.pass[idx(cx, cz + dz)]) continue;
          }
          const dCost = danger ? danger(cc.x, cc.z) : 0;
          if (dCost > 50) continue; // effectively blocked by known danger
          const step = CELL * (dx !== 0 && dz !== 0 ? 1.4142 : 1) * (1 + dCost);
          const ng = g[cur] + step;
          if (ng < g[ni]) {
            g[ni] = ng;
            fScore[ni] = ng + h(ni);
            parent[ni] = cur;
            open.push(ni);
          }
        }
      }
    }
    if (parent[goal] < 0 && goal !== start) return null;

    // Reconstruct cell path.
    const cells: number[] = [];
    let c = goal;
    while (c !== -1) {
      cells.push(c);
      if (c === start) break;
      c = parent[c];
    }
    cells.reverse();

    // Convert to world points and smooth with line-of-sight shortcutting.
    const pts = cells.map((i) => this.cellCenter(i % n, Math.floor(i / n)));
    pts.push({ x: to.x, z: to.z });
    const smoothed: { x: number; z: number }[] = [];
    let anchor = { x: from.x, z: from.z };
    let i = 0;
    while (i < pts.length) {
      let far = i;
      for (let k = pts.length - 1; k > i; k--) {
        if (this.lineClear(anchor.x, anchor.z, pts[k].x, pts[k].z, constraints)) {
          far = k;
          break;
        }
      }
      const p = pts[far];
      smoothed.push(p);
      anchor = p;
      i = far + 1;
      if (smoothed.length > 40) break;
    }

    return smoothed.map((p) => vec3(p.x, this.cruiseY(p.x, p.z, preferredDepth), p.z));
  }
}
