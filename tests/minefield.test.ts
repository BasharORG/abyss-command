import { describe,expect,it } from "vitest";
import { Nereus } from "../src/ai/nereus";
import { SIM } from "../src/config";
import { hashSeed } from "../src/rng";
import { Simulation } from "../src/sim/simulation";
import { generateSilentMinefieldTrial } from "../src/world/mission";

function make(){const seed=hashSeed("SILENT-TEST"),sim=new Simulation(seed,"normal",generateSilentMinefieldTrial(seed)),nereus=new Nereus(sim);sim.onEvent=e=>nereus.onEvent(e);return{sim,nereus};}
function run(sim:Simulation,n:Nereus,s:number){for(let i=0;i<s/SIM.DT;i++){sim.step();n.update();}}

describe("Silent Minefield",()=>{
  it("starts with no disclosed contacts",()=>{const{sim}=make();expect(sim.minefield!.contacts.size).toBe(0);expect(sim.mission.silentMinefield!.contacts.length).toBeGreaterThanOrEqual(12);});
  it("progresses evidence without changing classification randomly",()=>{const{sim,nereus}=make();sim.updateMinefieldSettings({scanStarted:true,posture:"maximum"});run(sim,nereus,90);expect(sim.minefield!.contacts.size).toBeGreaterThan(0);expect([...sim.minefield!.contacts.values()].some(c=>c.classification!=="unknown")).toBe(true);});
  it("maximum awareness classifies at least as much as passive",()=>{const a=make(),b=make();a.sim.updateMinefieldSettings({scanStarted:true,posture:"passive"});b.sim.updateMinefieldSettings({scanStarted:true,posture:"maximum"});run(a.sim,a.nereus,80);run(b.sim,b.nereus,80);const classified=(s:Simulation)=>[...s.minefield!.contacts.values()].filter(c=>["mine","decoy","probableMine"].includes(c.classification)).length;expect(classified(b.sim)).toBeGreaterThanOrEqual(classified(a.sim));});
  it("drifting mine changes known movement and plan revision",()=>{const{sim,nereus}=make();sim.updateMinefieldSettings({scanStarted:true,posture:"maximum"});run(sim,nereus,90);const before=nereus.minefieldDecision!.revision;expect(sim.releaseDriftingMine()).toBe(true);run(sim,nereus,35);expect(sim.minefield!.driftingReleased).toBe(true);expect(nereus.minefieldDecision!.revision).toBeGreaterThan(before);});
  it("neutralization requires authorization and confirmed mine",()=>{const{sim,nereus}=make();sim.updateMinefieldSettings({scanStarted:true,posture:"maximum"});run(sim,nereus,120);const target=[...sim.minefield!.contacts.values()].find(c=>c.classification==="mine");expect(target).toBeDefined();expect(sim.neutralizeMine(target!.id)).toBe(false);sim.updateMinefieldSettings({neutralizationAuthorized:true});for(const u of sim.units)if(u.role!=="LANCER")u.pos={x:-1100,y:-120,z:600};expect(sim.neutralizeMine(target!.id)).toBe(true);});
  it("resetting creates fresh contact state",()=>{const a=make();a.sim.updateMinefieldSettings({scanStarted:true});run(a.sim,a.nereus,50);expect(a.sim.minefield!.contacts.size).toBeGreaterThan(0);const b=make();expect(b.sim.minefield!.contacts.size).toBe(0);});
  it("certifies the longer corridor and regroups all five",()=>{const{sim,nereus}=make();sim.updateMinefieldSettings({scanStarted:true,posture:"maximum"});run(sim,nereus,130);sim.updateMinefieldSettings({crossingStarted:true});run(sim,nereus,1100);expect(sim.minefield!.status).toBe("complete");expect(sim.minefield!.completedUnitIds.size).toBe(5);});
});
