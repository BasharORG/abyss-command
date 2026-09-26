import{describe,expect,it}from"vitest";
import{CommandController}from"../src/command/controller";
import{CommandContext}from"../src/command/parser";
import{Simulation}from"../src/sim/simulation";
import{Nereus}from"../src/ai/nereus";
import{hashSeed}from"../src/rng";
import{generateMission}from"../src/world/mission";

function make(){const sim=new Simulation(hashSeed("CMDX"),"normal",generateMission(hashSeed("CMDX"),"normal")),nereus=new Nereus(sim);sim.onEvent=e=>nereus.onEvent(e);const c=new CommandController();return{sim,nereus,c};}
function context(sim:Simulation,revision=1):CommandContext{return{revision,selectedUnitId:"unit-GHOST",selectedContactId:null,entities:sim.units.map(u=>({id:u.id,label:u.callsign,kind:"unit",pos:u.pos,manual:u.control.mode==="manual",connected:sim.network.links.get(u.id)?.state!=="disconnected"}))};}
function run(sim:Simulation,nereus:Nereus,seconds:number){for(let i=0;i<seconds*60;i++){sim.step();nereus.update();}}

describe("central command end-to-end effects",()=>{
  it("hold freezes the fleet",()=>{const{sim,nereus,c}=make();c.parse("hold fleet",context(sim),sim.now);c.execute(sim,context(sim));run(sim,nereus,2);expect(sim.fleetOrder?.kind).toBe("hold");expect(sim.units.every(u=>u.speed<0.5)).toBe(true);});
  it("regroup moves the fleet to Atlas",()=>{const{sim,nereus,c}=make();c.parse("regroup",context(sim),sim.now);c.execute(sim,context(sim));run(sim,nereus,4);expect(sim.fleetOrder?.kind).toBe("regroup");});
  it("extract is refused before core recovery",()=>{const{sim,c}=make();c.parse("extract",context(sim),sim.now);const out=c.execute(sim,context(sim),true);expect(out?.state).toBe("failed");expect(sim.fleetOrder).toBeNull();});
  it("directives change speed",()=>{const{sim,nereus,c}=make();c.parse("flank speed",context(sim),sim.now);c.execute(sim,context(sim),true);run(sim,nereus,3);expect(sim.directives.speed).toBe("flank");});
  it("directives change depth and affect waypoint depth",()=>{const{sim,nereus,c}=make();c.parse("shallow depth",context(sim),sim.now);c.execute(sim,context(sim));run(sim,nereus,3);expect(sim.directives.depth).toBe("shallow");const moving=sim.units.find(u=>u.task.path.length>0);if(moving){const wp=moving.task.path[0];expect(wp.y).toBeGreaterThan(-60);}});
  it("directives change emissions and suppress active ping",()=>{const{sim,nereus,c}=make();c.parse("passive sensors only",context(sim),sim.now);c.execute(sim,context(sim));run(sim,nereus,2);expect(sim.directives.emissions).toBe("passive");});
  it("directives change formation and regroup radius",()=>{const{sim,nereus,c}=make();c.parse("wide search",context(sim),sim.now);c.execute(sim,context(sim));c.parse("regroup",context(sim),sim.now);c.execute(sim,context(sim));run(sim,nereus,1);expect(sim.directives.formation).toBe("search");});
  it("directives change cohesion and risk",()=>{const{sim,c}=make();c.parse("independent assignments",context(sim),sim.now);c.execute(sim,context(sim),true);c.parse("conservative risk",context(sim),sim.now);c.execute(sim,context(sim));expect(sim.directives.cohesion).toBe("independent");expect(sim.directives.risk).toBe("conservative");});
  it("protect regroups on the named vessel",()=>{const{sim,c}=make();c.parse("protect Atlas",context(sim),sim.now);c.execute(sim,context(sim));expect(sim.fleetOrder?.kind).toBe("regroup");expect(sim.fleetOrder?.targetId).toBe("unit-ATLAS");});
  it("repair targets the named vessel",()=>{const{sim,nereus,c}=make();const atlas=sim.units.find(u=>u.role==="ATLAS")!;atlas.hull=10;c.parse("repair Atlas",context(sim),sim.now);c.execute(sim,context(sim));run(sim,nereus,2);const mender=sim.units.find(u=>u.role==="MENDER")!;expect(mender.task.kind).toBe("repair");expect(mender.task.targetId).toBe("unit-ATLAS");});
  it("resume clears the order",()=>{const{sim,c}=make();c.parse("hold fleet",context(sim),sim.now);c.execute(sim,context(sim));c.parse("resume",context(sim),sim.now);c.execute(sim,context(sim));expect(sim.fleetOrder).toBeNull();});
  it("cancel clears the order",()=>{const{sim,c}=make();c.parse("hold fleet",context(sim),sim.now);c.execute(sim,context(sim));c.parse("cancel",context(sim),sim.now);c.execute(sim,context(sim));expect(sim.fleetOrder).toBeNull();});
  it("doctrine changes the doctrine",()=>{const{sim,c}=make();c.parse("go silent",context(sim),sim.now);c.execute(sim,context(sim));expect(sim.doctrine).toBe("silent");});
  it("network policy and posture apply",()=>{const{sim,c}=make();c.parse("allow degraded links",context(sim),sim.now);c.execute(sim,context(sim));c.parse("silent burst",context(sim),sim.now);c.execute(sim,context(sim));expect(sim.network.policy).toBe("degraded");expect(sim.network.posture).toBe("burst");});
  it("relay deploys from an Echo unit",()=>{const{sim,c}=make();c.parse("let Echo operate as a relay",context(sim),sim.now);c.execute(sim,context(sim),true);expect(sim.network.relays.length).toBeGreaterThan(0);});
  it("investigate requires a resolved target",()=>{const{sim,c}=make();c.parse("investigate area",context(sim),sim.now);expect(c.pending?.state).toBe("clarification");expect(c.execute(sim,context(sim))).toBeNull();});
  it("authorize neutralization is refused outside a minefield",()=>{const{sim,c}=make();c.parse("authorize neutralization",context(sim),sim.now);const out=c.execute(sim,context(sim),true);expect(out?.state).toBe("failed");});
});
