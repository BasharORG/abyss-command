/**
 * Telemetry derivation: turns raw simulation + commander state into the
 * command-readout model shown by the HUD and world overlays.
 *
 * Everything here is derived from real state — assigned tasks, paths,
 * controller outputs recorded by stepMovement, contacts, and orders.
 * Nothing is fabricated; transient states (completed/cancelled) surface
 * through the command log, not through these live readings.
 */

import { COMBAT } from "../config";
import { Nereus } from "../ai/nereus";
import { Simulation } from "../sim/simulation";
import { spec } from "../sim/units";
import { Doctrine, FleetOrderKind, Unit, Vec3, distXZ } from "../types";

export type ExecStatus = "queued" | "executing" | "holding" | "blocked" | "lost";

export interface UnitCommand {
  /** strategic assignment from NEREUS (task description) */
  task: string;
  /** immediate physical action being executed right now */
  action: string;
  /** resolved target / destination label */
  target: string;
  /** live execution state, derived from movement + task state */
  status: ExecStatus;
  /** final destination of the assigned path, if any */
  goal: Vec3 | null;
  /** next waypoint the controller is steering toward, if any */
  nextWaypoint: Vec3 | null;
}

export type CommanderState =
  | "replanning"
  | "responding" // responding to a threat
  | "holding"
  | "executing"
  | "complete";

export const COMMANDER_STATE_LABELS: Record<CommanderState, string> = {
  replanning: "Replanning",
  responding: "Responding to threat",
  holding: "Holding",
  executing: "Executing",
  complete: "Mission over"
};

export const STATUS_LABELS: Record<ExecStatus, string> = {
  queued: "Queued",
  executing: "Executing",
  holding: "Holding",
  blocked: "Blocked",
  lost: "Lost"
};

const ARRIVE_DIST = 30;

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Resolve a task's target/destination to a short human label. */
export function targetLabel(u: Unit, sim: Simulation): string {
  const t = u.task;
  switch (t.kind) {
    case "attack":
    case "distract":
    case "jam":
      return "security node";
    case "recover":
      return "research facility";
    case "fetchcore":
      return "dropped data core";
    case "survey": {
      const o = t.targetId ? sim.objectives.find((x) => x.id === t.targetId) : null;
      return o ? o.label.replace(/^Survey /, "") : "survey beacon";
    }
    case "escort":
    case "repair":
    case "rescue": {
      const target = t.targetId ? sim.unit(t.targetId) : null;
      return target ? target.callsign : "ally";
    }
    case "exfil":
      return t.targetId?.startsWith("withdraw") ? "extraction (withdrawal)" : "extraction zone";
    case "investigate":
      return "marked contact";
    case "transit":
      return t.corridorId === "narrow" ? "Narrow Cut" : "Outer Passage";
    case "regroup":
      return "formation point";
    case "scout":
      return t.targetId === "order-advance" ? "marked position" : "scout point";
    case "hold":
      return "current position";
    case "idle":
      return "—";
    default:
      return t.pos ? `${Math.round(t.pos.x)}, ${Math.round(t.pos.z)}` : "—";
  }
}

/** Where the assigned path ends (the strategic destination). */
export function taskGoalOf(u: Unit): Vec3 | null {
  const p = u.task.path;
  if (p.length > 0) return p[p.length - 1];
  return u.task.pos;
}

/** The waypoint the movement controller is currently steering toward. */
export function nextWaypointOf(u: Unit): Vec3 | null {
  const p = u.task.path;
  if (p.length === 0 || u.task.pathIndex >= p.length) return null;
  return p[u.task.pathIndex];
}

/** Live execution status, honestly derived from movement state. */
export function execStatus(u: Unit, sim: Simulation): ExecStatus {
  if (u.state === "destroyed") return "lost";
  if (u.state === "disabled") return "blocked";
  const t = u.task;
  if (t.kind === "idle" || t.kind === "hold") return "holding";
  // mid-interaction (survey dwell, repair, recovery) is execution
  if (u.interactProgress > 0.01) return "executing";
  const goal = taskGoalOf(u);
  const hasPath = t.path.length > 0 && t.pathIndex < t.path.length;
  const nearGoal = goal ? distXZ(u.pos, goal) < ARRIVE_DIST : true;
  // parked at the end of the assigned path: controller has no steering command
  if (hasPath && nearGoal && u.targetSpeed < 0.5) return "holding";
  if (!hasPath) {
    // no path and not at goal: pathfinding failed or task is stationary
    if (goal && !nearGoal) {
      // stationary tasks (distract loiter, on-station waits) hold by design
      if (t.kind === "distract") return "executing";
      return "blocked";
    }
    return "holding";
  }
  // wants to move but barely moving: obstructed
  if (u.targetSpeed > 1 && u.speed < 0.3 && sim.now - t.committedAt > 3) return "blocked";
  // freshly committed, not yet underway
  if (sim.now - t.committedAt < 2 && u.speed < 1) return "queued";
  return "executing";
}

/** The immediate physical action, from controller + interaction state. */
export function immediateAction(u: Unit, sim: Simulation): string {
  if (u.state === "destroyed") return "—";
  if (u.state === "disabled") return "Dead in the water";
  const t = u.task;
  // active interactions first — they are the real action
  if (u.interactProgress > 0.01) {
    const pct = ` ${Math.round(u.interactProgress * 100)}%`;
    if (t.kind === "repair" || t.kind === "rescue") return `Repairing ${targetLabel(u, sim)}${pct}`;
    if (t.kind === "recover" || t.kind === "fetchcore") return `Recovering data core${pct}`;
    if (t.kind === "survey") return `Surveying${pct}`;
    if (t.kind === "exfil") return `In extraction zone${pct}`;
    return `Working${pct}`;
  }
  if (t.kind === "attack") {
    const node = sim.nodes.find((n) => n.id === t.targetId);
    if (node && node.state !== "disabled" && node.state !== "destroyed") {
      const d = distXZ(u.pos, node.pos);
      if (d < COMBAT.TORPEDO_RANGE) return "Engaging with torpedoes";
      return "Closing to firing position";
    }
  }
  if (t.kind === "transit") {
    if (u.speed < u.targetSpeed - 0.6) return "Accelerating into assigned passage";
    return t.corridorId === "narrow" ? "Entering narrow passage" : "Following outer route";
  }
  if (t.kind === "jam" && sim.now < u.jamUntil) return "Jamming hostile sensors";
  if (t.kind === "distract" && t.path.length === 0) return "Loitering loudly (pinging)";
  if (t.kind === "idle") return "Standing by";
  if (t.kind === "hold") return "Holding position";
  const goal0 = taskGoalOf(u);
  if (goal0 && distXZ(u.pos, goal0) < ARRIVE_DIST && u.targetSpeed < 0.5) return "On station";
  const wp = nextWaypointOf(u);
  if (!wp) {
    if (goal0 && distXZ(u.pos, goal0) >= ARRIVE_DIST) return "No route — awaiting replan";
    return "On station";
  }
  // steering state from actual controller output
  if (u.cmdHeading !== null) {
    const dh = Math.abs(angleDiff(u.cmdHeading, u.heading));
    if (dh > 0.5) return "Turning toward waypoint";
  }
  if (u.speed < u.targetSpeed - 0.6) return "Accelerating";
  if (u.speed > u.targetSpeed + 0.6) return "Slowing";
  const i = t.pathIndex + 1;
  return `Transiting waypoint ${i}/${t.path.length}`;
}

/** Full per-unit command readout. */
export function unitCommand(u: Unit, sim: Simulation): UnitCommand {
  return {
    task: u.task.desc ?? u.task.kind,
    action: immediateAction(u, sim),
    target: targetLabel(u, sim),
    status: execStatus(u, sim),
    goal: taskGoalOf(u),
    nextWaypoint: nextWaypointOf(u)
  };
}

/** Commander state, derived from real planner + threat state. */
export function commanderState(sim: Simulation, nereus: Nereus): CommanderState {
  if (sim.outcome) return "complete";
  if (sim.now - nereus.lastPlanAt < 1.5 && nereus.lastPlanReason !== "routine") return "replanning";
  if (sim.nodes.some((n) => n.state === "alert")) return "responding";
  if (sim.fleetOrder?.kind === "hold") return "holding";
  return "executing";
}

export const ORDER_LABELS: Record<FleetOrderKind, string> = {
  advance: "Advance",
  regroup: "Regroup",
  hold: "Hold",
  repairs: "Prioritize repairs",
  investigate: "Investigate",
  extract: "Extract"
};

export const DOCTRINE_LABELS: Record<Doctrine, string> = {
  silent: "Silent",
  balanced: "Balanced",
  urgent: "Urgent"
};

/** Speed-order label for the throttle readout (matches stepMovement bands). */
export function speedOrderLabel(order: number): string {
  return order <= 0 ? "Silent" : order === 1 ? "Standard" : "Flank";
}

/** The commanded speed ceiling for the current speed order, per role. */
export function orderedSpeed(u: Unit): number {
  const s = spec(u.role);
  return u.speedOrder <= 0 ? s.silentSpeed : u.speedOrder === 1 ? s.cruiseSpeed : s.maxSpeed;
}
