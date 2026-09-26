import { describe, expect, it } from "vitest";
import { Nereus } from "../src/ai/nereus";
import { SIM } from "../src/config";
import { hashSeed } from "../src/rng";
import { Simulation } from "../src/sim/simulation";
import { generateCanyonPassageTrial } from "../src/world/mission";

function makeTrial() {
  const seed = hashSeed("CANYON-TEST");
  const sim = new Simulation(seed, "normal", generateCanyonPassageTrial(seed));
  const nereus = new Nereus(sim);
  sim.onEvent = (event) => nereus.onEvent(event);
  return { sim, nereus };
}

function run(sim: Simulation, nereus: Nereus, seconds: number) {
  for (let i = 0; i < seconds / SIM.DT; i++) {
    sim.step();
    nereus.update();
  }
}

describe("Canyon Passage", () => {
  it("keeps every vessel on the common outer route when cohesion is required", () => {
    const { sim, nereus } = makeTrial();
    run(sim, nereus, 55);
    expect(nereus.trialDecision).not.toBeNull();
    expect(nereus.trialDecision!.assessments.every((route) => route.status !== "unverified")).toBe(true);
    expect(new Set(nereus.trialDecision!.units.map((unit) => unit.corridorId))).toEqual(new Set(["outer"]));
  });

  it("splits compatible hulls through Narrow Cut when fastest split is enabled", () => {
    const { sim, nereus } = makeTrial();
    sim.updateTrialSettings({ priority: "fastest", coordination: "split", clearanceMargin: 2 });
    run(sim, nereus, 55);
    const routes = new Set(nereus.trialDecision!.units.map((unit) => unit.corridorId));
    expect(routes).toEqual(new Set(["narrow", "outer"]));
    const narrow = nereus.trialDecision!.assessments.find((route) => route.corridorId === "narrow")!;
    expect(narrow.usableBy).toContain("GHOST");
    expect(narrow.usableBy).not.toContain("ATLAS");
  });

  it("increasing clearance invalidates Narrow Cut for every hull", () => {
    const { sim, nereus } = makeTrial();
    sim.updateTrialSettings({ priority: "fastest", coordination: "split", clearanceMargin: 12 });
    run(sim, nereus, 55);
    const narrow = nereus.trialDecision!.assessments.find((route) => route.corridorId === "narrow")!;
    expect(narrow.usableBy).toHaveLength(0);
    expect(nereus.trialDecision!.units.every((unit) => unit.corridorId === "outer")).toBe(true);
  });

  it("invalidates Narrow Cut and replans when the rockfall is introduced", () => {
    const { sim, nereus } = makeTrial();
    sim.updateTrialSettings({ priority: "fastest", coordination: "split", clearanceMargin: 2 });
    run(sim, nereus, 55);
    const before = nereus.trialDecision!.revision;
    expect(nereus.trialDecision!.units.some((unit) => unit.corridorId === "narrow")).toBe(true);
    expect(sim.introduceTrialObstruction()).toBe(true);
    run(sim, nereus, 30);
    expect(nereus.trialDecision!.revision).toBeGreaterThan(before);
    expect(nereus.trialDecision!.assessments.find((route) => route.corridorId === "narrow")!.status).toBe("blocked");
    expect(nereus.trialDecision!.units.every((unit) => unit.corridorId === "outer")).toBe(true);
  });

  it("releases Narrow Cut vessels sequentially", () => {
    const { sim, nereus } = makeTrial();
    sim.updateTrialSettings({ priority: "fastest", coordination: "split", clearanceMargin: 2 });
    run(sim, nereus, 55);
    const narrow = nereus.trialDecision!.units.filter((unit) => unit.corridorId === "narrow");
    expect(narrow.length).toBeGreaterThan(1);
    expect(narrow.filter((unit) => unit.state === "entering")).toHaveLength(1);
    expect(narrow.some((unit) => unit.state === "waiting")).toBe(true);
  });

  it("completes with all five submarines regrouped", { timeout: 120000 }, () => {
    const { sim, nereus } = makeTrial();
    run(sim, nereus, 620);
    expect(sim.canyonTrial!.status).toBe("complete");
    expect(sim.canyonTrial!.completedUnitIds.size).toBe(5);
  });

  it("fails when fewer than three submarines survive", () => {
    const { sim, nereus } = makeTrial();
    for (const u of sim.units.slice(0, 3)) sim.damageUnit(u, 10000, "test");
    run(sim, nereus, 1);
    expect(sim.outcome).toBe("lost");
    expect(sim.canyonTrial!.status).toBe("failed");
  });
});
