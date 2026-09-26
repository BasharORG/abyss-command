import * as THREE from "three";
import { Vec3 } from "../types";
import { Terrain } from "../world/terrain";
import { WORLD } from "../config";

export type CameraMode = "cinematic" | "follow" | "tactical";

export interface CameraSubject {
  pos: Vec3;
  heading: number;
}

export interface CameraContext {
  focus: Vec3;
  featured: CameraSubject;
  selected: CameraSubject | null;
  fleet: Vec3[];
  terrain: Terrain;
  interacting: boolean;
  reducedMotion: boolean;
}

function terrainSafe(pos: THREE.Vector3, terrain: Terrain) {
  const floor = terrain.seabedY(pos.x, pos.z) + 14;
  if (pos.y < floor) pos.y = floor;
  if (pos.y > -8) pos.y = -8;
  const limit = WORLD.HALF + 520;
  pos.x = THREE.MathUtils.clamp(pos.x, -limit, limit);
  pos.z = THREE.MathUtils.clamp(pos.z, -limit, limit);
}

function centroid(points: Vec3[]): THREE.Vector3 {
  const out = new THREE.Vector3();
  if (points.length === 0) return out;
  for (const p of points) out.add(new THREE.Vector3(p.x, p.y, p.z));
  return out.multiplyScalar(1 / points.length);
}

/** Smooth, terrain-aware cameras composed around the fleet rather than a point orbit. */
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = "cinematic";

  private followYaw = 0.5;
  private followPitch = 0.2;
  private followDist = 108;
  private followHeading = 0;
  private tacticalX = 0;
  private tacticalZ = 0;
  private tacticalHeight = 720;
  private tacticalInit = false;
  private cinematicYaw = 0;
  private cinematicDistance = 1;
  private cinematicLift = 0;
  private lookAt = new THREE.Vector3(-1050, -135, 30);
  private desired = new THREE.Vector3(-960, -95, 180);
  private desiredLook = new THREE.Vector3();
  private tmpForward = new THREE.Vector3();
  private tmpRight = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(46, aspect, 0.5, 6200);
    this.camera.position.copy(this.desired);
  }

  setMode(mode: CameraMode) {
    this.mode = mode;
    this.camera.fov = mode === "tactical" ? 48 : 46;
    this.camera.updateProjectionMatrix();
  }

  onDrag(dx: number, dy: number) {
    if (this.mode === "follow") {
      this.followYaw -= dx * 0.0045;
      this.followPitch = THREE.MathUtils.clamp(this.followPitch + dy * 0.0035, -0.12, 0.72);
    } else if (this.mode === "tactical") {
      const scale = this.tacticalHeight / 760;
      this.tacticalX -= dx * scale;
      this.tacticalZ -= dy * scale;
      this.tacticalX = THREE.MathUtils.clamp(this.tacticalX, -WORLD.HALF, WORLD.HALF);
      this.tacticalZ = THREE.MathUtils.clamp(this.tacticalZ, -WORLD.HALF, WORLD.HALF);
    } else {
      this.cinematicYaw = THREE.MathUtils.clamp(this.cinematicYaw - dx * 0.0025, -0.65, 0.65);
      this.cinematicLift = THREE.MathUtils.clamp(this.cinematicLift - dy * 0.12, -18, 70);
    }
  }

  onWheel(deltaY: number) {
    const scale = Math.exp(deltaY * 0.001);
    if (this.mode === "follow") {
      this.followDist = THREE.MathUtils.clamp(this.followDist * scale, 68, 260);
    } else if (this.mode === "tactical") {
      this.tacticalHeight = THREE.MathUtils.clamp(this.tacticalHeight * scale, 330, 1450);
    } else {
      this.cinematicDistance = THREE.MathUtils.clamp(this.cinematicDistance * scale, 0.72, 1.65);
    }
  }

  tacticalJumpTo(p: Vec3) {
    this.tacticalX = p.x;
    this.tacticalZ = p.z;
    this.tacticalInit = true;
  }

  update(dt: number, ctx: CameraContext) {
    if (this.mode === "follow" && ctx.selected) this.composeFollow(ctx.selected);
    else if (this.mode === "tactical") this.composeTactical(ctx);
    else this.composeCinematic(dt, ctx);

    if (this.mode !== "tactical") {
      terrainSafe(this.desired, ctx.terrain);
      this.clearSightline(ctx.terrain);
    }

    const posRate = this.mode === "cinematic" ? 1.65 : 4.8;
    const lookRate = this.mode === "cinematic" ? 2.1 : 6.2;
    this.camera.position.lerp(this.desired, 1 - Math.exp(-posRate * dt));
    this.lookAt.lerp(this.desiredLook, 1 - Math.exp(-lookRate * dt));
    this.camera.lookAt(this.lookAt);
  }

  private composeCinematic(dt: number, ctx: CameraContext) {
    const featured = ctx.featured;
    const fleetCenter = centroid(ctx.fleet);
    const focus = new THREE.Vector3(ctx.focus.x, ctx.focus.y, ctx.focus.z);
    const featuredPos = new THREE.Vector3(featured.pos.x, featured.pos.y, featured.pos.z);
    const eventIsRemote = featuredPos.distanceTo(focus) > 300;

    if (eventIsRemote) {
      if (!ctx.interacting && !ctx.reducedMotion) this.cinematicYaw += dt * 0.025;
      const a = 0.72 + this.cinematicYaw;
      this.desired.set(
        focus.x - Math.sin(a) * 145 * this.cinematicDistance,
        focus.y + 42 + this.cinematicLift,
        focus.z - Math.cos(a) * 145 * this.cinematicDistance
      );
      this.desiredLook.copy(focus);
      return;
    }

    // Three-quarter fleet portrait: camera is just ahead and to starboard of
    // the featured vessel, looking back through the other four submarines.
    this.tmpForward.set(Math.sin(featured.heading), 0, Math.cos(featured.heading));
    this.tmpRight.set(this.tmpForward.z, 0, -this.tmpForward.x);
    const fleetRadius = Math.max(90, ...ctx.fleet.map((p) => Math.hypot(p.x - fleetCenter.x, p.z - fleetCenter.z)));
    const forward = 66 + Math.min(55, fleetRadius * 0.22);
    const side = 62 + Math.min(42, fleetRadius * 0.18);
    this.desired.copy(featuredPos)
      .addScaledVector(this.tmpForward, forward * this.cinematicDistance)
      .addScaledVector(this.tmpRight, (side + this.cinematicYaw * 45) * this.cinematicDistance);
    this.desired.y += 31 + this.cinematicLift + Math.min(20, fleetRadius * 0.06);

    this.desiredLook.copy(fleetCenter).lerp(featuredPos, 0.32);
    this.desiredLook.addScaledVector(this.tmpForward, -14);
    this.desiredLook.y -= 4;
  }

  private composeFollow(subject: CameraSubject) {
    const p = new THREE.Vector3(subject.pos.x, subject.pos.y, subject.pos.z);
    let dh = subject.heading - this.followHeading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.followHeading += dh * 0.12;
    const forward = this.tmpForward.set(Math.sin(this.followHeading), 0, Math.cos(this.followHeading));
    const right = this.tmpRight.set(forward.z, 0, -forward.x);
    const yawForward = forward.clone().multiplyScalar(Math.cos(this.followYaw)).addScaledVector(right, Math.sin(this.followYaw));
    const horizontal = this.followDist * Math.cos(this.followPitch);
    this.desired.copy(p).addScaledVector(yawForward, -horizontal);
    this.desired.y += 25 + Math.sin(this.followPitch) * this.followDist * 0.55;
    this.desiredLook.copy(p).addScaledVector(forward, 44);
    this.desiredLook.y += 1;
  }

  private composeTactical(ctx: CameraContext) {
    if (!this.tacticalInit) {
      const fleetCenter = centroid(ctx.fleet);
      this.tacticalX = fleetCenter.x;
      this.tacticalZ = fleetCenter.z;
      this.tacticalInit = true;
    }
    this.desired.set(this.tacticalX, this.tacticalHeight, this.tacticalZ + this.tacticalHeight * 0.13);
    this.desiredLook.set(this.tacticalX, -165, this.tacticalZ);
  }

  private clearSightline(terrain: Terrain) {
    let lift = 0;
    for (let i = 1; i < 8; i++) {
      const t = i / 8;
      const x = THREE.MathUtils.lerp(this.desired.x, this.desiredLook.x, t);
      const z = THREE.MathUtils.lerp(this.desired.z, this.desiredLook.z, t);
      const lineY = THREE.MathUtils.lerp(this.desired.y, this.desiredLook.y, t);
      lift = Math.max(lift, terrain.seabedY(x, z) + 9 - lineY);
    }
    if (lift > 0) this.desired.y += lift + 5;
  }
}
