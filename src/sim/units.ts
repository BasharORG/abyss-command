import { Role, ROLES, Unit, UnitTask, Vec3, vec3 } from "../types";
import { ROLE_SPECS, RoleSpec, WORLD } from "../config";
import { Terrain } from "../world/terrain";
import { fullSubsystems, loadout } from "../logistics/domain";
import { subsystemFactor } from "../logistics/domain";

export function spec(role: Role): RoleSpec {
  return ROLE_SPECS[role];
}

export function createUnit(role: Role, index: number, pos: Vec3, now: number): Unit {
  const s = spec(role);
  return {
    id: `unit-${role}`,
    role,
    callsign: role,
    hullNumber: `SSN-0${index + 1}`,
    state: "active",
    pos: { ...pos },
    prevPos: { ...pos },
    heading: Math.PI / 2, // face east (+X)
    prevHeading: Math.PI / 2,
    pitch: 0,
    prevPitch: 0,
    bank: 0,
    prevBank: 0,
    yawRate: 0,
    speed: 0,
    targetSpeed: 0,
    verticalSpeed: 0,
    depth: -pos.y,
    cmdHeading: null,
    cmdDepth: null,
    turnCmd: 0,
    hull: s.hull,
    battery: 100,
    noise: 0,
    sonarActiveUntil: -1,
    jamUntil: -1,
    jamCooldownUntil: -1,
    torpedoes: s.torpedoes,
    repairKits: s.repairKits,
    hasCore: false,
    interactProgress: 0,
    task: idleTask(now),
    stuckTime: 0,
    lastPosForStuck: { ...pos },
    stuckCheckAt: now,
    speedOrder: 1,
    detectedBy: new Set(),
    control: { mode: "autonomous" },
    logistics: loadout({role,emphasis:"balanced"}),
    subsystems: fullSubsystems()
  };
}

export function cloneTask(task: UnitTask): UnitTask {
  return { ...task, pos: task.pos ? { ...task.pos } : null, path: task.path.map((p) => ({ ...p })) };
}

export function createFleet(deployment: Vec3[], now: number): Unit[] {
  return ROLES.map((role, i) => createUnit(role, i, deployment[i % deployment.length], now));
}

export function idleTask(now: number): UnitTask {
  return {
    kind: "idle",
    pos: null,
    targetId: null,
    committedAt: now,
    commitUntil: now,
    path: [],
    pathIndex: 0
  };
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export interface MoveResult {
  arrived: boolean;
  waypointReached: boolean;
}

/**
 * Advance a unit along its task path with bounded physics.
 * Returns arrival flags. Does not handle interactions/combat.
 */
export function stepMovement(
  u: Unit,
  dt: number,
  terrain: Terrain,
  separation: Vec3 // precomputed repulsion from allies/hazards
): MoveResult {
  const s = spec(u.role);
  const propulsionSpeed=subsystemFactor(u,"propulsion",.35),propulsionControl=subsystemFactor(u,"propulsion",.45);
  const res: MoveResult = { arrived: false, waypointReached: false };
  u.prevPos = { ...u.pos };
  u.prevHeading = u.heading;
  u.prevPitch = u.pitch;
  u.prevBank = u.bank;

  if (u.state !== "active") {
    u.targetSpeed = 0;
    u.speed = Math.max(0, u.speed - s.accel * propulsionControl * dt);
    u.cmdHeading = null;
    u.cmdDepth = null;
    u.turnCmd = 0;
    u.yawRate *= Math.max(0, 1 - dt * 3);
    u.verticalSpeed = 0;
    // drift down gently when dead in the water, rest on seabed
    if (u.state === "disabled") {
      const floor = terrain.seabedY(u.pos.x, u.pos.z) + WORLD.SEABED_MARGIN * 0.6;
      u.pos.y = Math.max(floor, u.pos.y - 1.2 * dt);
      u.verticalSpeed = u.pos.y > floor ? 1.2 : 0;
    }
    u.depth = -u.pos.y;
    u.noise = u.speed * 0.5;
    return res;
  }

  // Desired point: next waypoint, or hold position.
  let desired: Vec3 | null = null;
  const task = u.task;
  const manual = u.control.mode === "manual" ? u.control : null;
  const recovering = u.control.mode === "recovering";
  if (!manual && !recovering && task.path.length > 0 && task.pathIndex < task.path.length) {
    desired = task.path[task.pathIndex];
    // advance waypoints when close (in x/z)
    while (
      task.pathIndex < task.path.length - 1 &&
      Math.hypot(desired.x - u.pos.x, desired.z - u.pos.z) < 26
    ) {
      task.pathIndex++;
      desired = task.path[task.pathIndex];
      res.waypointReached = true;
    }
    // Safe polyline lookahead: steer through upcoming segments without
    // inventing geometry outside the route.
    const lookahead = Math.max(30, Math.min(120, u.speed * 2.2 + (u.speed * u.speed) / Math.max(2, s.turnRate * 80)));
    let remaining = lookahead;
    let ax = u.pos.x;
    let ay = u.pos.y;
    let az = u.pos.z;
    for (let i = task.pathIndex; i < task.path.length; i++) {
      const p = task.path[i];
      const seg = Math.hypot(p.x - ax, p.z - az);
      if (seg >= remaining && seg > 0.01) {
        const q = remaining / seg;
        desired = { x: ax + (p.x - ax) * q, y: ay + (p.y - ay) * q, z: az + (p.z - az) * q };
        break;
      }
      remaining -= seg;
      desired = p;
      ax = p.x; ay = p.y; az = p.z;
    }
    const last = task.path[task.path.length - 1];
    if (task.pathIndex >= task.path.length - 1 && Math.hypot(last.x - u.pos.x, last.z - u.pos.z) < 22) {
      res.arrived = true;
    }
  }

  // Speed target from speed order and distance to final waypoint.
  let wantSpeed = 0;
  if (manual) {
    wantSpeed = THREE_CLAMP(manual.command.throttle, 0, s.maxSpeed*propulsionSpeed);
  } else if (recovering) {
    wantSpeed = 0;
  } else if (desired && !res.arrived) {
    const base =
      u.speedOrder <= 0 ? s.silentSpeed : u.speedOrder === 1 ? s.cruiseSpeed : s.maxSpeed;
    const distFinal =
      task.path.length > 0
        ? Math.hypot(task.path[task.path.length - 1].x - u.pos.x, task.path[task.path.length - 1].z - u.pos.z)
        : 0;
    wantSpeed = distFinal < 60 ? Math.min(base, s.silentSpeed) : base;
    if (task.speedLimit !== undefined) wantSpeed = Math.min(wantSpeed, task.speedLimit);
    // battery conservation: force economical speed when low; adrift when empty
    if (u.battery < 12) wantSpeed = Math.min(wantSpeed, s.silentSpeed);
    if (u.battery <= 0.5) wantSpeed = 0;
  }
  u.targetSpeed = wantSpeed;

  // Steering: heading toward desired point (with separation applied).
  if (manual && wantSpeed >= 0) {
    const desiredHeading = manual.command.heading;
    const dh = angleDiff(desiredHeading, u.heading);
    const maxRate = s.turnRate*propulsionControl * (0.8 + 0.35 * (u.speed / s.maxSpeed));
    const desiredRate = Math.max(-maxRate, Math.min(maxRate, dh * 1.7));
    const yawAccel = s.turnRate * 2.8;
    u.yawRate += Math.max(-yawAccel * dt, Math.min(yawAccel * dt, desiredRate - u.yawRate));
    const turn = u.yawRate * dt;
    u.heading += turn;
    u.bank += ((u.yawRate / Math.max(.01,maxRate)) * .35 - u.bank) * Math.min(1,dt*3);
    u.cmdHeading=desiredHeading;u.turnCmd=u.yawRate;
    const wantedY=-manual.command.depth,dy=wantedY-u.pos.y,maxV=s.vertRate*propulsionControl*dt,appliedDy=Math.max(-maxV,Math.min(maxV,dy));
    u.pos.y+=appliedDy;u.verticalSpeed=-appliedDy/dt;u.cmdDepth=manual.command.depth;
    u.pitch+=((Math.abs(dy)>1?-Math.sign(dy)*.18:0)-u.pitch)*Math.min(1,dt*2.5);
  } else if (desired && wantSpeed > 0.1) {
    const tx = desired.x + separation.x - u.pos.x;
    const tz = desired.z + separation.z - u.pos.z;
    const desiredHeading = Math.atan2(tx, tz);
    const dh = angleDiff(desiredHeading, u.heading);
    const maxRate = s.turnRate*propulsionControl * (0.8 + 0.35 * (u.speed / s.maxSpeed));
    const desiredRate = Math.max(-maxRate, Math.min(maxRate, dh * 1.7));
    const yawAccel = s.turnRate * 2.8;
    u.yawRate += Math.max(-yawAccel * dt, Math.min(yawAccel * dt, desiredRate - u.yawRate));
    const turn = u.yawRate * dt;
    const maxTurn = maxRate * dt;
    u.heading += turn;
    u.bank += ((turn / Math.max(1e-5, maxTurn)) * 0.35 - u.bank) * Math.min(1, dt * 3);
    u.cmdHeading = desiredHeading;
    u.cmdDepth = -desired.y;
    u.turnCmd = turn / dt;

    // slow for hard turns
    if (Math.abs(dh) > 1.1) u.targetSpeed = Math.min(u.targetSpeed, s.silentSpeed);

    // vertical: ease toward desired depth
    const dy = desired.y - u.pos.y;
    const maxV = s.vertRate*propulsionControl * dt;
    const appliedDy = Math.max(-maxV, Math.min(maxV, dy));
    u.pos.y += appliedDy;
    u.verticalSpeed = -appliedDy / dt; // + = descending (depth increasing)
    u.pitch += ((Math.abs(dy) > 1 ? -Math.sign(dy) * 0.18 : 0) - u.pitch) * Math.min(1, dt * 2.5);
  } else {
    u.bank *= Math.max(0, 1 - dt * 2);
    u.pitch *= Math.max(0, 1 - dt * 2);
    u.cmdHeading = null;
    u.cmdDepth = null;
    u.turnCmd = 0;
    u.yawRate *= Math.max(0, 1 - dt * 3);
    u.verticalSpeed = 0;
  }

  // Accelerate / decelerate.
  u.targetSpeed=Math.min(u.targetSpeed,s.maxSpeed*propulsionSpeed);
  const dv = u.targetSpeed - u.speed;
  u.speed += Math.max(-s.accel*propulsionControl * 1.6 * dt, Math.min(s.accel*propulsionControl * dt, dv));

  // Integrate horizontal motion along heading.
  u.pos.x += Math.sin(u.heading) * u.speed * dt;
  u.pos.z += Math.cos(u.heading) * u.speed * dt;

  // Hard depth limits: below surface margin, above seabed.
  const floor = terrain.seabedY(u.pos.x, u.pos.z) + WORLD.SEABED_MARGIN;
  const ceil = -WORLD.SURFACE_MARGIN;
  if (u.pos.y > ceil) u.pos.y = ceil;
  if (u.pos.y < floor) u.pos.y = floor;
  u.depth = -u.pos.y;

  // Noise: speed-driven. Active-sonar boost is applied by the simulation
  // (it owns the clock). See DETECTION.PING_NOISE_BOOST.
  const sRatio = u.speed / s.maxSpeed;
  u.noise = s.signature * (0.25 + 0.75 * sRatio * sRatio);
  return res;
}

function THREE_CLAMP(v:number,min:number,max:number){return Math.max(min,Math.min(max,v));}

/** Simple separation steering from allies and known point hazards. */
export function computeSeparation(u: Unit, allies: Unit[], hazards: { pos: Vec3; radius: number }[]): Vec3 {
  const out = vec3(0, 0, 0);
  if (u.state !== "active") return out;
  for (const a of allies) {
    if (a.id === u.id) continue;
    const dx = u.pos.x - a.pos.x;
    const dz = u.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    const minD = 46;
    if (d > 0.01 && d < minD) {
      const f = ((minD - d) / minD) * 60;
      out.x += (dx / d) * f;
      out.z += (dz / d) * f;
    }
  }
  for (const hz of hazards) {
    const dx = u.pos.x - hz.pos.x;
    const dz = u.pos.z - hz.pos.z;
    const d = Math.hypot(dx, dz);
    const minD = hz.radius;
    if (d > 0.01 && d < minD) {
      const f = ((minD - d) / minD) * 90;
      out.x += (dx / d) * f;
      out.z += (dz / d) * f;
    }
  }
  // cap
  const m = Math.hypot(out.x, out.z);
  if (m > 80) {
    out.x = (out.x / m) * 80;
    out.z = (out.z / m) * 80;
  }
  return out;
}
