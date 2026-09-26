import * as THREE from "three";
import { MissionSpec } from "../world/mission";
import { WORLD } from "../config";
import { fbm } from "../world/terrain";
import { Rng } from "../rng";

/** Seabed mesh displaced by the mission heightfield, colored by depth. */
export function buildTerrain(mission: MissionSpec): THREE.Mesh {
  const renderHalf = WORLD.HALF + 1050;
  const size = renderHalf * 2;
  const segs = 240;
  const geo = new THREE.PlaneGeometry(size, size, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cSand = new THREE.Color(0x4a5a55);
  const cRock = new THREE.Color(0x37474f);
  const cAbyss = new THREE.Color(0x1a2531);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const edgeDistance = Math.max(0, Math.abs(x) - WORLD.HALF, Math.abs(z) - WORLD.HALF);
    const sampleX = THREE.MathUtils.clamp(x, -WORLD.HALF, WORLD.HALF);
    const sampleZ = THREE.MathUtils.clamp(z, -WORLD.HALF, WORLD.HALF);
    let d = mission.terrain.depthAt(sampleX, sampleZ);

    // Continue the seabed beyond the simulation bounds instead of exposing its edge.
    if (edgeDistance > 0) {
      const shelf = smoothstep(Math.min(1, edgeDistance / 850));
      const outerRelief = (fbm(x * 0.0028, z * 0.0028, mission.seed + 913, 3) - 0.5) * 36;
      d += shelf * (145 + outerRelief);
    }

    // Small render-only erosion breaks up canyon walls without altering navigation data.
    const canyon = nearestCanyon(x, z, mission);
    if (edgeDistance === 0 && canyon) {
      const wall = 1 - Math.abs(canyon.normalized * 2 - 1);
      const strata = Math.sin(x * 0.045 + z * 0.027) * 0.5 + 0.5;
      d += wall * (strata - 0.45) * 9;
    }
    pos.setY(i, -d);
    // color by depth + noise variation
    const n = fbm(x * 0.01, z * 0.01, mission.seed + 77, 3);
    if (d < 120) tmp.lerpColors(cSand, cRock, d / 120);
    else tmp.lerpColors(cRock, cAbyss, Math.min(1, (d - 120) / 160));
    const sediment = canyon ? Math.pow(1 - canyon.normalized, 3) : 0;
    if (sediment > 0) tmp.lerp(cSand, sediment * 0.3);
    const v = 0.82 + n * 0.34;
    colors[i * 3] = tmp.r * v;
    colors[i * 3 + 1] = tmp.g * v;
    colors[i * 3 + 2] = tmp.b * v;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.04
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

export function setTerrainDetail(mesh:THREE.Mesh,level:"low"|"medium"|"high"){const mat=mesh.material as THREE.MeshStandardMaterial;mat.flatShading=level==="low";mat.roughness=level==="high"?.92:.96;mat.needsUpdate=true;mesh.receiveShadow=level!=="low";}

/** Instanced rock clusters scattered by the mission generator. */
export function buildRocks(mission: MissionSpec): THREE.InstancedMesh {
  const geo = new THREE.DodecahedronGeometry(6, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a4750, roughness: 0.95, metalness: 0.05 });
  const rng = new Rng(mission.seed ^ 0x20c5);
  const rubble: { pos: THREE.Vector3; rot: number; scale: number }[] = [];
  for (const canyon of mission.terrain.canyons) {
    for (let p = 0; p < canyon.pts.length - 1; p++) {
      const a = canyon.pts[p];
      const b = canyon.pts[p + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const clusters = Math.max(1, Math.floor(length / 210));
      for (let c = 0; c < clusters; c++) {
        const t = (c + rng.range(0.2, 0.8)) / clusters;
        const cx = THREE.MathUtils.lerp(a.x, b.x, t);
        const cz = THREE.MathUtils.lerp(a.z, b.z, t);
        const angle = Math.atan2(b.z - a.z, b.x - a.x) + (rng.chance(0.5) ? 1 : -1) * Math.PI / 2;
        const offset = rng.range(canyon.inner * 0.75, canyon.outer * 0.92);
        const pieces = rng.int(3, 7);
        for (let j = 0; j < pieces; j++) {
          const x = cx + Math.cos(angle) * offset + rng.range(-18, 18);
          const z = cz + Math.sin(angle) * offset + rng.range(-18, 18);
          rubble.push({
            pos: new THREE.Vector3(x, -mission.terrain.depthAt(x, z) + rng.range(0.2, 1.5), z),
            rot: rng.range(0, Math.PI * 2),
            scale: rng.range(0.18, 0.65)
          });
        }
      }
    }
  }
  const rocks = [...mission.rocks, ...rubble];
  const inst = new THREE.InstancedMesh(geo, mat, rocks.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  rocks.forEach((r, i) => {
    e.set(rng.range(-0.3, 0.3), r.rot, rng.range(-0.3, 0.3));
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(r.pos.x, r.pos.y, r.pos.z),
      q,
      new THREE.Vector3(r.scale, r.scale * rng.range(0.6, 1.3), r.scale)
    );
    inst.setMatrixAt(i, m);
  });
  inst.castShadow = true;
  inst.receiveShadow = true;
  return inst;
}

/** Sparse layered canyon props: strata, low vegetation, and survey remnants. */
export function buildCanyonLife(mission: MissionSpec): THREE.Group {
  const group = new THREE.Group();
  const rng = new Rng(mission.seed ^ 0x7ca2);
  const strataGeo = new THREE.DodecahedronGeometry(8, 0);
  const strataMat = new THREE.MeshStandardMaterial({ color: 0x43535a, roughness: 0.92, metalness: 0.08 });
  const strata: { x: number; y: number; z: number; sx: number; sy: number; sz: number; r: number }[] = [];
  const plants: { x: number; y: number; z: number; s: number; r: number }[] = [];
  for (const canyon of mission.terrain.canyons) {
    for (let i = 0; i < canyon.pts.length - 1; i++) {
      const a = canyon.pts[i]; const b = canyon.pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const tx = (b.x - a.x) / Math.max(1, len); const tz = (b.z - a.z) / Math.max(1, len);
      for (let d = 80; d < len; d += rng.range(120, 210)) {
        const cx = a.x + tx * d; const cz = a.z + tz * d;
        for (const side of [-1, 1]) {
          const x = cx - tz * side * rng.range(canyon.inner * .8, canyon.outer * .88);
          const z = cz + tx * side * rng.range(canyon.inner * .8, canyon.outer * .88);
          strata.push({ x, y: -mission.terrain.depthAt(x, z) + 6, z, sx: rng.range(.7, 1.8), sy: rng.range(1.8, 4.8), sz: rng.range(.5, 1.4), r: Math.atan2(tx, tz) });
          if (rng.chance(.65)) plants.push({ x: x + rng.range(-16, 16), y: -mission.terrain.depthAt(x, z) + 1, z: z + rng.range(-16, 16), s: rng.range(3, 9), r: rng.range(0, Math.PI) });
        }
      }
    }
  }
  const rockInst = new THREE.InstancedMesh(strataGeo, strataMat, strata.length);
  const m = new THREE.Matrix4(); const q = new THREE.Quaternion();
  strata.forEach((p, i) => { q.setFromEuler(new THREE.Euler(0, p.r, rng.range(-.25, .25))); m.compose(new THREE.Vector3(p.x,p.y,p.z), q, new THREE.Vector3(p.sx,p.sy,p.sz)); rockInst.setMatrixAt(i,m); });
  group.add(rockInst);
  const plantGeo = new THREE.ConeGeometry(.35, 1, 5);
  plantGeo.translate(0, .5, 0);
  const plantMat = new THREE.MeshStandardMaterial({ color: 0x355f57, roughness: .86, metalness: 0, side: THREE.DoubleSide });
  const plantInst = new THREE.InstancedMesh(plantGeo, plantMat, plants.length);
  plants.forEach((p, i) => { q.setFromEuler(new THREE.Euler(0, p.r, .08)); m.compose(new THREE.Vector3(p.x,p.y,p.z), q, new THREE.Vector3(p.s*.16,p.s,p.s*.16)); plantInst.setMatrixAt(i,m); });
  group.add(plantInst);
  if (mission.canyonTrial) {
    const remnantMat = new THREE.MeshStandardMaterial({ color: 0x34464e, roughness: .6, metalness: .62 });
    const remnant = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.2, 9, 8), remnantMat); body.position.y = 4.5; remnant.add(body);
    const dish = new THREE.Mesh(new THREE.TorusGeometry(4.5, .35, 8, 20, Math.PI * 1.45), remnantMat); dish.position.y = 9; dish.rotation.x = Math.PI/2; remnant.add(dish);
    remnant.position.set(50, -mission.terrain.depthAt(50, 420) + 1, 420); remnant.rotation.z = .18; group.add(remnant);
  }
  return group;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function nearestCanyon(x: number, z: number, mission: MissionSpec): { normalized: number } | undefined {
  let nearest = Infinity;
  let outer = 1;
  let inner = 0;
  for (const canyon of mission.terrain.canyons) {
    for (let i = 0; i < canyon.pts.length - 1; i++) {
      const a = canyon.pts[i];
      const b = canyon.pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      const t = lengthSq === 0 ? 0 : THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / lengthSq, 0, 1);
      const distance = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (distance < nearest) {
        nearest = distance;
        inner = canyon.inner;
        outer = canyon.outer;
      }
    }
  }
  if (nearest >= outer) return undefined;
  return { normalized: THREE.MathUtils.clamp((nearest - inner) / Math.max(1, outer - inner), 0, 1) };
}

/** Broken hull wreckage in the wreck field. */
export function buildWrecks(mission: MissionSpec): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2c3338, roughness: 0.85, metalness: 0.55 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x4d3a28, roughness: 0.95, metalness: 0.3 });
  const rng = new Rng(mission.seed ^ 0xbad1);
  for (const w of mission.wrecks) {
    const g = new THREE.Group();
    // snapped hull section
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.8, 18, 10, 1, true), mat);
    hull.rotation.z = Math.PI / 2 + rng.range(-0.3, 0.3);
    hull.rotation.y = rng.range(0, Math.PI);
    g.add(hull);
    // debris plates
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(rng.range(2, 6), 0.3, rng.range(1.5, 4)), rng.chance(0.5) ? mat : rust);
      p.position.set(rng.range(-8, 8), rng.range(-1, 1.5), rng.range(-8, 8));
      p.rotation.set(rng.range(0, 1), rng.range(0, Math.PI), rng.range(0, 1));
      g.add(p);
    }
    // a snapped mast or crane
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.3, 9, 6), rust);
    mast.position.set(rng.range(-4, 4), 2.5, rng.range(-4, 4));
    mast.rotation.z = rng.range(0.4, 1.2);
    g.add(mast);
    g.position.copy(w.pos as THREE.Vector3Like);
    g.rotation.y = w.rot;
    g.scale.setScalar(w.scale);
    group.add(g);
  }
  return group;
}

/** The abandoned research facility: habitat modules, domes, mast, amber windows. */
export function buildFacility(mission: MissionSpec): THREE.Group {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0x5a666e, roughness: 0.5, metalness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x323c44, roughness: 0.7, metalness: 0.6 });
  const window = new THREE.MeshStandardMaterial({
    color: 0x1a1408,
    emissive: new THREE.Color(0xffb347),
    emissiveIntensity: 0.9
  });

  // central dome
  const dome = new THREE.Mesh(new THREE.SphereGeometry(14, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), hull);
  g.add(dome);
  // habitat cylinders
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const mod = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 20, 12), i === 1 ? dark : hull);
    mod.rotation.z = Math.PI / 2;
    mod.rotation.y = a;
    mod.position.set(Math.cos(a) * 16, 4, Math.sin(a) * 16);
    g.add(mod);
    // window strips
    const win = new THREE.Mesh(new THREE.BoxGeometry(14, 1.2, 0.4), window);
    win.position.set(Math.cos(a) * 16, 5.5, Math.sin(a) * 16);
    win.rotation.y = -a + Math.PI / 2;
    g.add(win);
  }
  // antenna mast
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 26, 8), dark);
  mast.position.set(6, 20, -4);
  g.add(mast);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.9, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0x110b04, emissive: new THREE.Color(0xff5340), emissiveIntensity: 2.5 })
  );
  beacon.position.set(6, 33.5, -4);
  beacon.name = "facilityBeacon";
  g.add(beacon);
  const beaconColumn = new THREE.Mesh(
    new THREE.CylinderGeometry(5, 16, 150, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  beaconColumn.position.y = 75;
  beaconColumn.name = "facilityBeaconColumn";
  beaconColumn.visible = false;
  g.add(beaconColumn);
  // support legs
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 12, 6), dark);
    leg.position.set(Math.cos(a) * 12, -5, Math.sin(a) * 12);
    g.add(leg);
  }
  // pad lights
  const padLight = new THREE.PointLight(0xffb347, 120, 160, 1.8);
  padLight.position.set(0, 10, 0);
  g.add(padLight);

  const f = mission.facilityPos;
  g.position.set(f.x, -mission.terrain.depthAt(f.x, f.z) + 6, f.z);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

/** Hydrothermal vent chimneys with emissive tips. */
export function buildVents(mission: MissionSpec): THREE.Group {
  const g = new THREE.Group();
  const rock = new THREE.MeshStandardMaterial({ color: 0x2b3438, roughness: 0.95 });
  const glow = new THREE.MeshStandardMaterial({
    color: 0x201408,
    emissive: new THREE.Color(0xff7a2a),
    emissiveIntensity: 1.6
  });
  const rng = new Rng(mission.seed ^ 0x7e57);
  for (const v of mission.vents) {
    const cluster = new THREE.Group();
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const h = rng.range(4, 11) * v.scale;
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(rng.range(0.4, 0.8), rng.range(1.4, 2.4), h, 7), rock);
      cone.position.set(rng.range(-4, 4), h / 2, rng.range(-4, 4));
      cone.rotation.set(rng.range(-0.15, 0.15), 0, rng.range(-0.15, 0.15));
      cluster.add(cone);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.6, 7), glow);
      tip.position.copy(cone.position);
      tip.position.y = h + 0.2;
      cluster.add(tip);
    }
    cluster.position.copy(v.pos as THREE.Vector3Like);
    g.add(cluster);
  }
  return g;
}

/** Security node pylon with a state light ring. */
export function buildSecurityNode(): { group: THREE.Group; ring: THREE.Mesh; head: THREE.Mesh } {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x424f57, roughness: 0.5, metalness: 0.85 });
  const pylon = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.4, 18, 8), mat);
  pylon.position.y = 9;
  g.add(pylon);
  const head = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 8), mat);
  head.position.y = 19;
  g.add(head);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x101010,
    emissive: new THREE.Color(0x6fe8a0),
    emissiveIntensity: 2
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3, 0.35, 8, 24), ringMat);
  ring.position.y = 19;
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  // weapon tubes
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 6, 6), mat);
    tube.rotation.z = Math.PI / 2;
    tube.rotation.y = a;
    tube.position.set(Math.cos(a) * 2.4, 14, Math.sin(a) * 2.4);
    g.add(tube);
  }
  return { group: g, ring, head };
}

/** Naval mine: spiked sphere. */
export function buildMine(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.55, metalness: 0.8 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(2.2, 12, 8), mat);
  g.add(body);
  const spikeGeo = new THREE.ConeGeometry(0.35, 1.6, 5);
  const dirs = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [0.7, 0.7, 0], [-0.7, 0.7, 0], [0.7, 0, 0.7], [0, 0.7, 0.7]
  ];
  for (const [x, y, z] of dirs) {
    const spike = new THREE.Mesh(spikeGeo, mat);
    const dir = new THREE.Vector3(x, y, z).normalize();
    spike.position.copy(dir.clone().multiplyScalar(2.6));
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(spike);
  }
  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 6, 4),
    new THREE.MeshStandardMaterial({ color: 0x140505, emissive: new THREE.Color(0xff5340), emissiveIntensity: 1.8 })
  );
  light.position.y = 2.4;
  g.add(light);
  return g;
}

/** Extraction zone marker: ring of cyan beacons + light column. */
export function buildExtraction(mission: MissionSpec): THREE.Group {
  const g = new THREE.Group();
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0x0a1418,
    emissive: new THREE.Color(0x7fd8e8),
    emissiveIntensity: 2.4
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c363e, roughness: 0.7, metalness: 0.6 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 10, 6), dark);
    post.position.set(Math.cos(a) * 140, 5, Math.sin(a) * 140);
    g.add(post);
    const light = new THREE.Mesh(new THREE.SphereGeometry(1.1, 8, 6), beaconMat);
    light.position.set(Math.cos(a) * 140, 10.6, Math.sin(a) * 140);
    g.add(light);
  }
  // vertical light column
  const colGeo = new THREE.CylinderGeometry(30, 55, 260, 20, 1, true);
  const colMat = new THREE.MeshBasicMaterial({
    color: 0x7fd8e8,
    transparent: true,
    opacity: 0.05,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const col = new THREE.Mesh(colGeo, colMat);
  col.position.y = 130;
  g.add(col);
  const e = mission.extractionPos;
  g.position.set(e.x, -mission.terrain.depthAt(e.x, e.z), e.z);
  return g;
}

/** Objective beacon for survey points (small pulsing marker). */
export function buildObjectiveMarker(color: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0c1418,
    emissive: new THREE.Color(color),
    emissiveIntensity: 1.6
  });
  return new THREE.Mesh(new THREE.OctahedronGeometry(3, 0), mat);
}
