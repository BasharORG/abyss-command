import { expect, it } from "vitest";
import { Nereus } from "../src/ai/nereus";
import { hashSeed } from "../src/rng";
import { Simulation } from "../src/sim/simulation";
import { vec3 } from "../src/types";

it("LANCER fires torpedoes and disables a node when in range with LOS", () => {
  const sim = new Simulation(hashSeed("TORPEDO"), "normal");
  const nereus = new Nereus(sim);
  sim.onEvent = (e) => nereus.onEvent(e);
  sim.setPhase("survey");

  const node = sim.nodes[0];
  const lancer = sim.units.find((u) => u.role === "LANCER")!;
  // place Lancer 300m west of the node on the canyon floor (clear LOS along the channel)
  lancer.pos = vec3(node.pos.x - 300, node.pos.y + 20, node.pos.z);
  // fleet knows the node
  sim.contacts.set(`c-${node.id}`, {
    id: `c-${node.id}`,
    kind: "securityNode",
    pos: { ...node.pos },
    uncertainty: 20,
    lastSeenAt: 0,
    confirmed: true,
    refId: node.id
  });
  // make the node a threat near the facility so attack tasks generate
  sim.facilityRevealed = true;
  sim.setPhase("recovery");

  const torpsBefore = lancer.torpedoes;
  let fired = 0;
  const origFire = sim.fireTorpedo.bind(sim);
  sim.fireTorpedo = (u, id) => {
    const ok = origFire(u, id);
    if (ok) fired++;
    return ok;
  };
  for (let t = 0; t < 180 && node.state !== "disabled"; t += 1 / 60) {
    sim.step();
    nereus.update();
  }
  expect(fired).toBeGreaterThan(0);
  expect(lancer.torpedoes).toBeLessThan(torpsBefore);
  expect(node.state === "disabled" || node.hp < 3).toBe(true);
});
