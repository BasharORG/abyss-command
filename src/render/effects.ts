import * as THREE from "three";
import { Vec3 } from "../types";

const MAX_PARTICLES = 2400;
const MAX_SHELLS = 10;

interface Particle {
  alive: boolean;
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  buoyancy: number;
  size: number;
  r: number;
  g: number;
  b: number;
}

/**
 * Pooled particle + pressure-shell effects. Fixed capacity, zero
 * allocation during play (particles are recycled).
 */
export class Effects {
  private scene: THREE.Scene;
  private points: THREE.Points;
  private particles: Particle[] = [];
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private sizeAttr: THREE.BufferAttribute;
  private cursor = 0;
  private shells: { mesh: THREE.Mesh; life: number; maxLife: number; grow: number }[] = [];
  quality = 1;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false, life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, buoyancy: 0, size: 1, r: 1, g: 1, b: 1
      });
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES), 1);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setAttribute("psize", this.sizeAttr);
    const mat = new THREE.PointsMaterial({
      size: 1.6,
      map: softParticleTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      sizeAttenuation: true
    });
    // custom shader not needed; use size attr via onBeforeCompile
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("uniform float size;", "attribute float psize;")
        .replace("gl_PointSize = size;", "gl_PointSize = psize;");
    };
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);

    // pressure shells
    const shellGeo = new THREE.SphereGeometry(1, 18, 12);
    for (let i = 0; i < MAX_SHELLS; i++) {
      const mesh = new THREE.Mesh(
        shellGeo,
        new THREE.MeshBasicMaterial({
          color: 0xbfe4ee,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.BackSide
        })
      );
      mesh.visible = false;
      this.scene.add(mesh);
      this.shells.push({ mesh, life: 0, maxLife: 1, grow: 30 });
    }
  }

  private emit(
    pos: Vec3,
    count: number,
    opts: { speed: number; up: number; buoyancy: number; life: number; size: number; r: number; g: number; b: number }
  ) {
    const n = Math.max(1, Math.round(count * this.quality));
    for (let i = 0; i < n; i++) {
      const idx = this.cursor;
      const p = this.particles[idx];
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      p.alive = true;
      p.life = 0;
      p.maxLife = opts.life * (0.6 + Math.random() * 0.8);
      const a = Math.random() * Math.PI * 2;
      const s = opts.speed * (0.3 + Math.random() * 0.7);
      p.vx = Math.cos(a) * s;
      p.vz = Math.sin(a) * s;
      p.vy = opts.up * (0.5 + Math.random() * 0.5);
      p.buoyancy = opts.buoyancy;
      p.size = opts.size * (0.6 + Math.random() * 0.8);
      p.r = opts.r;
      p.g = opts.g;
      p.b = opts.b;
      this.posAttr.setXYZ(
        idx,
        pos.x + (Math.random() - 0.5) * 2,
        pos.y + (Math.random() - 0.5) * 2,
        pos.z + (Math.random() - 0.5) * 2
      );
    }
  }

  /** bubbles rising (damage leaks, vents, prop bursts) */
  spawnBubbles(pos: Vec3, count: number, size = 1) {
    this.emit(pos, count, {
      speed: 1.5, up: 2, buoyancy: 9, life: 3.2, size: 1.1 * size, r: 0.75, g: 0.9, b: 0.95
    });
  }

  /** sediment disturbance */
  spawnSediment(pos: Vec3, count: number) {
    this.emit(pos, count, {
      speed: 7, up: 1.2, buoyancy: -0.4, life: 4.5, size: 2.6, r: 0.42, g: 0.44, b: 0.4
    });
  }

  /** impact: pressure shell + bubbles + sediment */
  spawnImpact(pos: Vec3, scale = 1) {
    const shell = this.shells.find((s) => !s.mesh.visible);
    if (shell) {
      shell.mesh.visible = true;
      shell.mesh.position.set(pos.x, pos.y, pos.z);
      shell.life = 0;
      shell.maxLife = 0.9;
      shell.grow = 46 * scale;
      shell.mesh.scale.setScalar(1);
    }
    this.spawnBubbles(pos, 26, 1.6);
    this.spawnSediment(pos, 18);
  }

  /** sonar ping ring (flat, expanding) */
  spawnPing(pos: Vec3) {
    const shell = this.shells.find((s) => !s.mesh.visible);
    if (shell) {
      shell.mesh.visible = true;
      shell.mesh.position.set(pos.x, pos.y, pos.z);
      shell.life = 0;
      shell.maxLife = 1.4;
      shell.grow = 120;
      shell.mesh.scale.setScalar(2);
    }
  }

  update(dt: number) {
    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    const siz = this.sizeAttr.array as Float32Array;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.alive) {
        siz[i] = 0;
        continue;
      }
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        siz[i] = 0;
        continue;
      }
      p.vy += p.buoyancy * dt;
      pos[i * 3] += p.vx * dt;
      pos[i * 3 + 1] += p.vy * dt;
      pos[i * 3 + 2] += p.vz * dt;
      const fade = 1 - p.life / p.maxLife;
      siz[i] = p.size * (0.5 + fade);
      col[i * 3] = p.r * fade;
      col[i * 3 + 1] = p.g * fade;
      col[i * 3 + 2] = p.b * fade;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;

    for (const s of this.shells) {
      if (!s.mesh.visible) continue;
      s.life += dt;
      const t = s.life / s.maxLife;
      if (t >= 1) {
        s.mesh.visible = false;
        continue;
      }
      const r = 1 + s.grow * t;
      s.mesh.scale.setScalar(r);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.35 * (1 - t);
    }
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    const particleMaterial = this.points.material as THREE.PointsMaterial;
    particleMaterial.map?.dispose();
    particleMaterial.dispose();
    for (const s of this.shells) {
      this.scene.remove(s.mesh);
      (s.mesh.material as THREE.Material).dispose();
    }
  }
}

function softParticleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.22, "rgba(255,255,255,0.92)");
  gradient.addColorStop(0.58, "rgba(255,255,255,0.34)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
