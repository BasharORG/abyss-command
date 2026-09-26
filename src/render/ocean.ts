import * as THREE from "three";
import { WORLD } from "../config";
import { Rng } from "../rng";

/** Depth-aware fog + background. */
export class OceanAtmosphere {
  private scene: THREE.Scene;
  private fog: THREE.FogExp2;
  private shallow = new THREE.Color(0x17485b);
  private mid = new THREE.Color(0x0b2b3a);
  private deep = new THREE.Color(0x071824);
  private tmp = new THREE.Color();
  private scale = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.fog = new THREE.FogExp2(0x061826, 0.0028);
    scene.fog = this.fog;
    scene.background = new THREE.Color(0x061826);
  }

  /** smoothly scale fog density (tactical view thins it for readability) */
  fogDensityScale(target: number, dt: number) {
    this.scale += (target - this.scale) * Math.min(1, dt * 2.5);
  }

  update(cameraY: number) {
    const depth = -cameraY;
    const t = Math.min(1, Math.max(0, depth / WORLD.MAX_DEPTH));
    if (t < 0.35) this.tmp.lerpColors(this.shallow, this.mid, t / 0.35);
    else this.tmp.lerpColors(this.mid, this.deep, (t - 0.35) / 0.65);
    this.fog.color.copy(this.tmp);
    (this.scene.background as THREE.Color).copy(this.tmp);
    // fog thickens slightly with depth
    this.fog.density = (0.00145 + t * 0.00105) * this.scale;
  }
}

/** Volumetric-looking light shafts hanging from the surface (additive cones). */
export class LightShafts {
  group = new THREE.Group();
  private shafts: { mesh: THREE.Mesh; baseOpacity: number; phase: number }[] = [];

  constructor(seed: number, near?: { x: number; z: number }) {
    const rng = new Rng(seed ^ 0x11aa);
    const tex = shaftTexture();
    for (let i = 0; i < 10; i++) {
      const w = rng.range(34, 90);
      const h = rng.range(240, 410);
      const geo = new THREE.PlaneGeometry(w, h);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(geo, mat);
      // bias a third of the shafts around the point of interest (deployment basin)
      const biased = near && i < 4;
      mesh.position.set(
        biased ? near.x + rng.range(-320, 320) : rng.range(-WORLD.HALF * 0.8, WORLD.HALF * 0.8),
        -h / 2 + 10,
        biased ? near.z + rng.range(-320, 320) : rng.range(-WORLD.HALF * 0.8, WORLD.HALF * 0.8)
      );
      mesh.rotation.y = rng.range(0, Math.PI);
      mesh.rotation.z = rng.range(-0.12, 0.12);
      this.shafts.push({ mesh, baseOpacity: rng.range(0.045, 0.09), phase: rng.range(0, Math.PI * 2) });
      this.group.add(mesh);
    }
  }

  update(time: number, cameraY: number) {
    // shafts fade as the camera goes deep
    const depthFade = Math.max(0, 1 - -cameraY / 260);
    for (const s of this.shafts) {
      (s.mesh.material as THREE.MeshBasicMaterial).opacity =
        s.baseOpacity * (0.7 + 0.3 * Math.sin(time * 0.3 + s.phase)) * depthFade;
    }
  }
}

function shaftTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "rgba(150,220,235,0.9)");
  grad.addColorStop(0.5, "rgba(120,190,215,0.35)");
  grad.addColorStop(1, "rgba(100,170,200,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  // soften horizontal edges
  const side = g.createLinearGradient(0, 0, 64, 0);
  side.addColorStop(0, "rgba(0,0,0,1)");
  side.addColorStop(0.3, "rgba(0,0,0,0)");
  side.addColorStop(0.7, "rgba(0,0,0,0)");
  side.addColorStop(1, "rgba(0,0,0,1)");
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = side;
  g.fillRect(0, 0, 64, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Marine snow: suspended particles drifting around the camera. */
export class MarineSnow {
  points: THREE.Points;
  private velocities: Float32Array;
  private count: number;
  private range = 260;

  constructor(count: number, seed: number) {
    this.count = count;
    const rng = new Rng(seed ^ 0x31ce);
    const pos = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-this.range, this.range);
      pos[i * 3 + 1] = rng.range(-this.range, this.range);
      pos[i * 3 + 2] = rng.range(-this.range, this.range);
      this.velocities[i * 3] = rng.range(-0.6, 0.6);
      this.velocities[i * 3 + 1] = rng.range(-1.4, -0.4); // slow sink
      this.velocities[i * 3 + 2] = rng.range(-0.6, 0.6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xa8c8d4,
      map: particleTexture(),
      size: 0.9,
      transparent: true,
      opacity: 0.55,
      sizeAttenuation: true,
      depthWrite: false
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  update(dt: number, cameraPos: THREE.Vector3) {
    const pos = this.points.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const r = this.range;
    for (let i = 0; i < this.count; i++) {
      let x = arr[i * 3] + (this.velocities[i * 3] + 0.42) * dt;
      let y = arr[i * 3 + 1] + this.velocities[i * 3 + 1] * dt;
      let z = arr[i * 3 + 2] + (this.velocities[i * 3 + 2] - 0.18) * dt;
      // wrap around camera
      if (x - cameraPos.x > r) x -= r * 2;
      else if (x - cameraPos.x < -r) x += r * 2;
      if (y - cameraPos.y > r) y -= r * 2;
      else if (y - cameraPos.y < -r) y += r * 2;
      if (z - cameraPos.z > r) z -= r * 2;
      else if (z - cameraPos.z < -r) z += r * 2;
      arr[i * 3] = x;
      arr[i * 3 + 1] = y;
      arr[i * 3 + 2] = z;
    }
    pos.needsUpdate = true;
  }

  setDensity(fraction: number) {
    const n = Math.floor(this.count * Math.max(0, Math.min(1, fraction)));
    this.points.geometry.setDrawRange(0, n);
  }
}

/** One-draw-call ambient fish schools with deterministic current and avoidance. */
export class FishSchools {
  points: THREE.Points;
  private base: Float32Array;
  private phases: Float32Array;
  private count: number;
  private center = new THREE.Vector3();

  constructor(seed: number, count = 160) {
    this.count = count;
    const rng = new Rng(seed ^ 0xf15c);
    this.base = new Float32Array(count * 3);
    this.phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.base[i*3] = rng.range(-110, 110); this.base[i*3+1] = rng.range(-35, 35); this.base[i*3+2] = rng.range(-75, 75); this.phases[i] = rng.range(0, Math.PI*2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.base.slice(), 3));
    const mat = new THREE.PointsMaterial({ color: 0x789da4, size: 2.2, transparent: true, opacity: .45, depthWrite: false, sizeAttenuation: true });
    this.points = new THREE.Points(geo, mat); this.points.frustumCulled = false;
  }

  update(time: number, camera: THREE.Vector3, threats: { pos: { x:number;y:number;z:number }; speed:number }[]) {
    this.center.lerp(camera, .002);
    const nearest = threats.reduce((best, t) => {
      const d = Math.hypot(this.center.x-t.pos.x,this.center.y-t.pos.y,this.center.z-t.pos.z);
      return d < best.d ? { d, t } : best;
    }, { d: Infinity, t: null as typeof threats[number] | null });
    if (nearest.t && nearest.d < 180) {
      const dx=this.center.x-nearest.t.pos.x, dz=this.center.z-nearest.t.pos.z, d=Math.hypot(dx,dz)||1;
      this.center.x += (dx/d) * nearest.t.speed * .08; this.center.z += (dz/d) * nearest.t.speed * .08;
    }
    const attr = this.points.geometry.attributes.position as THREE.BufferAttribute; const arr=attr.array as Float32Array;
    for(let i=0;i<this.count;i++) { arr[i*3]=this.center.x+this.base[i*3]+Math.sin(time*.35+this.phases[i])*9; arr[i*3+1]=this.center.y+this.base[i*3+1]+Math.sin(time*.7+this.phases[i])*2; arr[i*3+2]=this.center.z+this.base[i*3+2]+Math.cos(time*.3+this.phases[i])*7; }
    attr.needsUpdate=true;
  }
  setDensity(fraction:number){ this.points.geometry.setDrawRange(0,Math.floor(this.count*Math.max(0,Math.min(1,fraction)))); }
}

function particleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 15);
  gradient.addColorStop(0, "rgba(255,255,255,0.95)");
  gradient.addColorStop(0.28, "rgba(255,255,255,0.7)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

/** Animated caustic light sheet for shallow areas (deployment basin). */
export class Caustics {
  mesh: THREE.Mesh;
  private tex: THREE.CanvasTexture;
  private ctx: CanvasRenderingContext2D;
  private lastDraw = -1;

  constructor(centerX: number, centerZ: number, radius: number, y: number) {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    this.ctx = c.getContext("2d")!;
    this.tex = new THREE.CanvasTexture(c);
    const geo = new THREE.PlaneGeometry(radius * 2.6, radius * 2.6);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: this.tex,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.set(centerX, y, centerZ);
    this.mesh.renderOrder = 2;
  }

  update(time: number, cameraY: number) {
    // redraw at ~6 Hz; fade with camera depth
    const depthFade = Math.max(0, 1 - -cameraY / 200);
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = 0.1 * depthFade;
    if (depthFade <= 0) return;
    if (Math.abs(time - this.lastDraw) < 0.12) return;
    this.lastDraw = time;
    const g = this.ctx;
    g.clearRect(0, 0, 256, 256);
    const t = time * 0.34;
    g.globalCompositeOperation = "source-over";
    for (let i = 0; i < 34; i++) {
      const phase = i * 2.399 + t;
      const orbit = 18 + (i % 7) * 14;
      const x = 128 + Math.cos(phase * 0.83) * orbit + Math.sin(i * 4.1 + t) * 9;
      const y = 128 + Math.sin(phase * 1.07) * orbit + Math.cos(i * 3.7 - t) * 9;
      const r = 7 + (i % 5) * 2;
      const glow = g.createRadialGradient(x, y, 0, x, y, r);
      glow.addColorStop(0, "rgba(175,232,238,0.42)");
      glow.addColorStop(0.45, "rgba(140,215,228,0.16)");
      glow.addColorStop(1, "rgba(120,200,220,0)");
      g.fillStyle = glow;
      g.beginPath();
      g.ellipse(x, y, r * 1.7, r * 0.65, phase, 0, Math.PI * 2);
      g.fill();
    }
    const edgeMask = g.createRadialGradient(128, 128, 62, 128, 128, 128);
    edgeMask.addColorStop(0, "rgba(255,255,255,1)");
    edgeMask.addColorStop(0.72, "rgba(255,255,255,0.8)");
    edgeMask.addColorStop(1, "rgba(255,255,255,0)");
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = edgeMask;
    g.fillRect(0, 0, 256, 256);
    g.globalCompositeOperation = "source-over";
    this.tex.needsUpdate = true;
  }
}
