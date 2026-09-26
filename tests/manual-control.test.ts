import {describe,expect,it} from "vitest";
import {Nereus} from "../src/ai/nereus";
import {SIM} from "../src/config";
import {hashSeed} from "../src/rng";
import {Simulation} from "../src/sim/simulation";

function make(){const sim=new Simulation(hashSeed("MANUAL"),"normal"),nereus=new Nereus(sim);sim.onEvent=e=>nereus.onEvent(e);sim.setPhase("survey");return{sim,nereus};}
function run(sim:Simulation,n:Nereus,s:number){for(let i=0;i<s/SIM.DT;i++){sim.step();n.update();}}

describe("dual control",()=>{
  it("grants exclusive manual ownership and snapshots assignment",()=>{const{sim,nereus}=make();run(sim,nereus,3);const ghost=sim.units.find(u=>u.role==="GHOST")!,before=ghost.task.path.map(p=>({...p}));const token=sim.acquireManualControl(ghost.id)!;expect(sim.manualOwnerId).toBe(ghost.id);expect(ghost.control.mode).toBe("manual");if(ghost.control.mode==="manual")expect(ghost.control.suspended.task.path).toEqual(before);expect(sim.acquireManualControl(sim.units[0].id)).toBeNull();expect(token.session).toBeGreaterThan(0);});
  it("manual command drives one unit while NEREUS continues the other four",()=>{const{sim,nereus}=make();run(sim,nereus,3);const ghost=sim.units.find(u=>u.role==="GHOST")!,token=sim.acquireManualControl(ghost.id)!;const before=ghost.heading;sim.setManualCommand(token,{heading:before+1,throttle:ghost.speed+4});run(sim,nereus,2);expect(ghost.heading).not.toBe(before);expect(sim.units.filter(u=>u.id!==ghost.id&&u.control.mode==="autonomous")).toHaveLength(4);});
  it("switches atomically and rejects stale tokens",()=>{const{sim,nereus}=make();run(sim,nereus,2);const a=sim.acquireManualControl(sim.units[0].id)!,b=sim.switchManualControl(a,sim.units[1].id)!;expect(sim.manualOwnerId).toBe(sim.units[1].id);expect(sim.setManualCommand(a,{throttle:9})).toBe(false);expect(sim.setManualCommand(b,{throttle:4})).toBe(true);});
  it("returns through recovery before autonomy",()=>{const{sim,nereus}=make();run(sim,nereus,2);const u=sim.units[0],token=sim.acquireManualControl(u.id)!;expect(sim.releaseManualControl(token)).toBe(true);expect(u.control.mode).toBe("recovering");sim.step();nereus.update();run(sim,nereus,1);expect(u.control.mode).toBe("autonomous");});
  it("standard assistance corrects unsafe depth",()=>{const{sim,nereus}=make();run(sim,nereus,1);const u=sim.units[0],token=sim.acquireManualControl(u.id,"standard")!;u.pos.y=sim.mission.terrain.seabedY(u.pos.x,u.pos.z)+11;sim.setManualCommand(token,{depth:300,throttle:12});sim.step();expect(u.control.mode).toBe("manual");if(u.control.mode==="manual")expect(u.control.correction).toContain("Terrain");});
});
