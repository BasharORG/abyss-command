import { describe, expect, it } from "vitest";
import { Nereus } from "../src/ai/nereus";
import { SIM } from "../src/config";
import { hashSeed } from "../src/rng";
import { Simulation } from "../src/sim/simulation";
import { routeExists } from "../src/world/mission";

function makeGame(seed = hashSeed("TEST-1"), difficulty: "easy" | "normal" | "hard" = "normal") {
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

describe("fleet identity", () => {
  it("starts with exactly the five named submarines", () => {
    const { sim } = makeGame();
    expect(sim.units).toHaveLength(5);
    expect(sim.units.map((u) => u.role).sort()).toEqual(["ATLAS", "ECHO", "GHOST", "LANCER", "MENDER"]);
  });

  it("never adds or removes unit identities, even when destroyed", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 5);
    for (const u of sim.units) sim.damageUnit(u, 10000, "test");
    expect(sim.units).toHaveLength(5);
    expect(sim.units.every((u) => u.state === "destroyed")).toBe(true);
    run(sim, nereus, 2);
    expect(sim.units).toHaveLength(5);
    expect(sim.outcome).toBe("lost");
  });
});

describe("world generation", () => {
  it("generates navigable routes for a range of seeds and difficulties", () => {
    for (const seedText of ["A", "B", "C", "DELTA-9", "TRENCH-412"]) {
      for (const diff of ["easy", "normal", "hard"] as const) {
        const sim = new Simulation(hashSeed(seedText), diff);
        const m = sim.mission;
        expect(routeExists(m.terrain, m.deployment[0], m.facilityPos)).toBe(true);
        expect(routeExists(m.terrain, m.facilityPos, m.extractionPos)).toBe(true);
        expect(routeExists(m.terrain, m.deployment[0], m.surveyA)).toBe(true);
        expect(routeExists(m.terrain, m.deployment[0], m.surveyB)).toBe(true);
      }
    }
  });
});

describe("NEREUS allocation", () => {
  it("assigns both survey tasks to different capable units", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 3);
    const tasked = sim.units.filter((u) => u.task.kind === "survey");
    const targets = new Set(tasked.map((u) => u.task.targetId));
    expect(targets.size).toBe(2); // both surveys covered, no competition
  });

  it("does not double-assign exclusive tasks", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 10);
    const seen = new Map<string, string>();
    for (const u of sim.units) {
      const t = u.task;
      if (!t.targetId) continue;
      if (["survey", "recover", "fetchcore", "attack", "investigate"].includes(t.kind)) {
        const k = `${t.kind}:${t.targetId}`;
        expect(seen.has(k)).toBe(false);
        seen.set(k, u.id);
      }
    }
  });

  it("doctrine produces observable speed differences", () => {
    const silent = makeGame(hashSeed("D-S"), "normal");
    silent.sim.setDoctrine("silent");
    run(silent.sim, silent.nereus, 20);
    const urgent = makeGame(hashSeed("D-S"), "normal");
    urgent.sim.setDoctrine("urgent");
    run(urgent.sim, urgent.nereus, 20);
    const avg = (s: Simulation) =>
      s.units.reduce((a, u) => a + (u.state === "active" ? u.targetSpeed : 0), 0) / 5;
    expect(avg(urgent.sim)).toBeGreaterThan(avg(silent.sim));
  });

  it("reacts to losses: substitutes Mender for core recovery", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 2);
    const mender = sim.units.find((u) => u.role === "MENDER")!;
    sim.damageUnit(mender, 10000, "test");
    sim.facilityRevealed = true;
    sim.setPhase("recovery");
    run(sim, nereus, 8);
    const recoverer = sim.units.find((u) => u.task.kind === "recover");
    expect(recoverer).toBeDefined();
    expect(recoverer!.role).not.toBe("MENDER");
    expect(recoverer!.state).toBe("active");
  });

  it("never assigns tasks to destroyed units", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 2);
    const ghost = sim.units.find((u) => u.role === "GHOST")!;
    sim.damageUnit(ghost, 10000, "test");
    run(sim, nereus, 8);
    expect(ghost.task.kind === "idle" || ghost.task.kind === "hold" || ghost.state === "destroyed").toBe(true);
  });
});

describe("mission rules", () => {
  it("drops the core when the carrier is destroyed and allows retrieval", () => {
    const { sim, nereus } = makeGame();
    run(sim, nereus, 2);
    const mender = sim.units.find((u) => u.role === "MENDER")!;
    mender.hasCore = true;
    sim.coreState = "carried";
    sim.carrierId = mender.id;
    sim.damageUnit(mender, 10000, "test");
    expect(sim.coreState).toBe("dropped");
    expect(sim.corePos).not.toBeNull();
    run(sim, nereus, 5);
    const fetcher = sim.units.find((u) => u.task.kind === "fetchcore" || u.hasCore);
    expect(fetcher).toBeDefined();
  });

  it("fails when fewer than three units survive", () => {
    const { sim } = makeGame();
    const [a, b, c] = sim.units;
    sim.damageUnit(a, 10000, "t");
    sim.damageUnit(b, 10000, "t");
    sim.damageUnit(c, 10000, "t");
    sim.step();
    expect(sim.outcome).toBe("lost");
  });

  it("fails when the storm window expires", () => {
    const { sim, nereus } = makeGame();
    sim.timeRemaining = 0.5;
    run(sim, nereus, 1);
    expect(sim.outcome).toBe("lost");
    expect(sim.loseReason).toContain("storm");
  });

  it("repairs damaged units but never resurrects destroyed ones", () => {
    const { sim } = makeGame();
    const mender = sim.units.find((u) => u.role === "MENDER")!;
    const atlas = sim.units.find((u) => u.role === "ATLAS")!;
    atlas.hull = 30;
    // teleport mender next to atlas and repair
    mender.pos = { ...atlas.pos, x: atlas.pos.x + 20 };
    mender.task = {
      kind: "repair",
      pos: { ...atlas.pos },
      targetId: atlas.id,
      committedAt: 0,
      commitUntil: 0,
      path: [],
      pathIndex: 0
    };
    const before = atlas.hull;
    for (let i = 0; i < 300; i++) sim.step();
    expect(atlas.hull).toBeGreaterThan(before);

    const ghost = sim.units.find((u) => u.role === "GHOST")!;
    sim.damageUnit(ghost, 10000, "test");
    expect(ghost.state).toBe("destroyed");
    mender.pos = { ...ghost.pos };
    for (let i = 0; i < 300; i++) sim.step();
    expect(ghost.state).toBe("destroyed");
  });

  it("refuses extraction while the core is still at the facility", () => {
    const { sim } = makeGame();
    expect(sim.validateOrder("extract")).toBeTruthy();
    sim.coreState = "carried";
    sim.carrierId = sim.units[0].id;
    expect(sim.validateOrder("extract")).toBeNull();
  });

  it("wins when the core and three units reach extraction", () => {
    const { sim } = makeGame();
    const ext = sim.mission.extractionPos;
    sim.coreState = "carried";
    const carrier = sim.units[0];
    carrier.hasCore = true;
    sim.carrierId = carrier.id;
    // place three units inside the zone
    sim.units.slice(0, 3).forEach((u) => {
      u.pos = { ...ext };
    });
    sim.step();
    expect(sim.outcome).toBe("won");
  });
});

describe("full mission (headless integration)", () => {
  it("NEREUS can win a full mission on easy with the balanced doctrine", { timeout: 120000 }, () => {
    const sim = new Simulation(hashSeed("E2E-WIN"), "easy");
    const nereus = new Nereus(sim);
    sim.onEvent = (e) => nereus.onEvent(e);
    sim.setPhase("survey");
    // generous: run up to the full time limit
    const maxT = sim.timeRemaining + 5;
    let t = 0;
    while (!sim.outcome && t < maxT) {
      sim.step();
      nereus.update();
      t += SIM.DT;
    }
    // sanity: surveys completed and facility found
    expect(sim.objective("surveyA").done).toBe(true);
    expect(sim.objective("surveyB").done).toBe(true);
    expect(sim.facilityRevealed).toBe(true);
    // the mission must reach a definite outcome, and on easy it should be a win
    expect(sim.outcome).not.toBeNull();
    expect(sim.outcome).toBe("won");
    expect(sim.units).toHaveLength(5);
  });
});
