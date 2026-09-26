import { describe, expect, it } from "vitest";
import { Nereus } from "../src/ai/nereus";
import { SIM } from "../src/config";
import { hashSeed } from "../src/rng";
import { Simulation } from "../src/sim/simulation";
import { spec } from "../src/sim/units";
import { commanderState, execStatus, immediateAction, targetLabel, unitCommand } from "../src/ui/telemetry";

function makeGame(seed = hashSeed("TELEM-1"), difficulty: "easy" | "normal" | "hard" = "normal") {
  const sim = new Simulation(seed, difficulty);
  const nereus = new Nereus(sim);
  sim.onEvent = (e) => nereus.onEvent(e);
  sim.setPhase("survey");
  return { sim, nereus };
}

function run(sim: Simulation, nereus: Nereus, seconds: number) {
  const steps = Math.floor(seconds / SIM.DT);
  for (let i = 0; i < steps; i++) {
    sim.step();
    nereus.update();
    if (sim.outcome) break;
  }
}

describe("controller instrumentation", () => {
  it("records commanded heading/depth and turn output while steering", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 10);
    const moving = sim.units.find((u) => u.state === "active" && u.task.path.length > 0);
    expect(moving).toBeDefined();
    expect(moving!.cmdHeading).not.toBeNull();
    expect(moving!.cmdDepth).not.toBeNull();
    // commanded heading is a finite bearing
    expect(Number.isFinite(moving!.cmdHeading)).toBe(true);
  });

  it("clears controller commands when holding with no path", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 3);
    const u = sim.units[0];
    u.task = {
      kind: "hold",
      pos: { ...u.pos },
      targetId: null,
      committedAt: sim.now,
      commitUntil: sim.now + 60,
      path: [],
      pathIndex: 0
    };
    u.speed = 0;
    sim.step();
    expect(u.cmdHeading).toBeNull();
    expect(u.turnCmd).toBe(0);
  });

  it("preserves previous transform state for render interpolation", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 3);
    const u = sim.units.find((unit) => unit.task.path.length > 0)!;
    const before = { pos: { ...u.pos }, heading: u.heading, pitch: u.pitch, bank: u.bank };
    sim.step();
    expect(u.prevPos).toEqual(before.pos);
    expect(u.prevHeading).toBe(before.heading);
    expect(u.prevPitch).toBe(before.pitch);
    expect(u.prevBank).toBe(before.bank);
  });

  it("ramps yaw rate instead of snapping to maximum turn", () => {
    const { sim } = makeGame();
    const u = sim.units[0];
    u.heading = 0;
    u.yawRate = 0;
    const goal = { x: u.pos.x + 300, y: u.pos.y, z: u.pos.z };
    u.task = { kind: "transit", pos: goal, targetId: "test", committedAt: 0, commitUntil: 100, path: [goal], pathIndex: 0 };
    u.speedOrder = 1;
    sim.step();
    expect(Number.isFinite(u.yawRate)).toBe(true);
    expect(Math.abs(u.yawRate)).toBeGreaterThan(0);
    expect(Math.abs(u.yawRate)).toBeLessThanOrEqual(spec(u.role).turnRate * 2.8 * SIM.DT + 1e-6);
  });
});

describe("command readout derivation", () => {
  it("every unit has a task, action, target, and status", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 5);
    for (const u of sim.units) {
      const cmd = unitCommand(u, sim);
      expect(cmd.task.length).toBeGreaterThan(0);
      expect(cmd.action.length).toBeGreaterThan(0);
      expect(cmd.target.length).toBeGreaterThan(0);
      expect(["queued", "executing", "holding", "blocked", "lost"]).toContain(cmd.status);
    }
  });

  it("survey assignments resolve to their canyon labels", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 3);
    const surveyor = sim.units.find((u) => u.task.kind === "survey");
    expect(surveyor).toBeDefined();
    expect(targetLabel(surveyor!, sim)).toContain("canyon route");
  });

  it("destroyed units read as lost, disabled as blocked", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 2);
    const ghost = sim.units.find((u) => u.role === "GHOST")!;
    sim.damageUnit(ghost, 10000, "test");
    expect(execStatus(ghost, sim)).toBe("lost");
    const atlas = sim.units.find((u) => u.role === "ATLAS")!;
    sim.damageUnit(atlas, 140, "test"); // 160 - 140 = 20 hull: disabled, not destroyed
    expect(atlas.state).toBe("disabled");
    expect(execStatus(atlas, sim)).toBe("blocked");
    expect(immediateAction(atlas, sim)).toBe("Dead in the water");
  });

  it("commander state reflects threat response", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 5);
    expect(commanderState(sim, nereus)).toBe("executing");
    sim.nodes[0].state = "alert";
    // let the planner observe the alert so the state isn't a fresh replan
    nereus.lastPlanAt = sim.now - 10;
    nereus.lastPlanReason = "routine";
    expect(commanderState(sim, nereus)).toBe("responding");
  });
});

describe("command timeline", () => {
  it("records real assignments with unit ids and positions", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 8);
    expect(nereus.commandLog.length).toBeGreaterThan(0);
    const assigned = nereus.commandLog.filter((c) => c.kind === "assigned" || c.kind === "reassigned");
    expect(assigned.length).toBeGreaterThan(0);
    for (const c of assigned) {
      expect(c.unitId).toBeTruthy();
      expect(sim.unit(c.unitId!)).toBeDefined();
    }
  });

  it("logs player order receipt and completion", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 3);
    const near = { ...sim.units[0].pos };
    sim.issueOrder("advance", { x: near.x + 30, y: near.y, z: near.z }, null);
    run(sim, nereus, 2);
    expect(nereus.commandLog.some((c) => c.kind === "order" && c.text.includes("advance"))).toBe(true);
    run(sim, nereus, 40);
    expect(nereus.commandLog.some((c) => c.kind === "completed" && c.text.includes("advance"))).toBe(true);
  });

  it("resets cleanly between missions (new commander, empty log)", () => {
    const a = makeGame();
    run(a.sim, a.nereus, 8);
    expect(a.nereus.commandLog.length).toBeGreaterThan(0);
    const b = makeGame();
    expect(b.nereus.commandLog.length).toBe(0);
    expect(b.nereus.decisions.length).toBe(0);
  });
});
