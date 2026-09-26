import { it } from "vitest";
import { Nereus } from "../src/ai/nereus";
import { SIM } from "../src/config";
import { hashSeed } from "../src/rng";
import { Simulation } from "../src/sim/simulation";

it("reports mission timeline", { timeout: 180000 }, () => {
  for (const [seedText, diff] of [
    ["E2E-WIN", "easy"],
    ["E2E-NORM", "normal"],
    ["E2E-NORM2", "normal"],
    ["E2E-HARD", "hard"]
  ] as const) {
    const sim = new Simulation(hashSeed(seedText), diff);
    const nereus = new Nereus(sim);
    sim.onEvent = (e) => {
      nereus.onEvent(e);
    };
    let torpsFired = 0;
    const origFire = sim.fireTorpedo.bind(sim);
    sim.fireTorpedo = (u, id) => {
      const ok = origFire(u, id);
      if (ok) torpsFired++;
      return ok;
    };
    sim.setPhase("survey");
    let t = 0;
    const marks: string[] = [];
    let lastPhase = sim.phase;
    while (!sim.outcome && t < sim.difficulty.timeLimit + 5) {
      sim.step();
      nereus.update();
      t += SIM.DT;
      if (sim.phase !== lastPhase) {
        marks.push(`${lastPhase}→${sim.phase} @ ${Math.round(t)}s`);
        lastPhase = sim.phase;
      }
    }
    const alive = sim.aliveUnits().length;
    const batteries = sim.units.map((u) => `${u.role[0]}:${Math.round(u.battery)}`).join(" ");
    const nodesDown = sim.nodes.filter((n) => n.state === "disabled" || n.state === "destroyed").length;
    console.log(
      `[${seedText}/${diff}] outcome=${sim.outcome} t=${Math.round(t)}s alive=${alive} | ${marks.join(" | ")} | batt ${batteries} | torps=${torpsFired} nodesDown=${nodesDown} | ${sim.loseReason}`
    );
  }
});
