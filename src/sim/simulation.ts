import { COMBAT, DETECTION, DOCTRINE, SCORING, SIM, WORLD } from "../config";
import {
  CanyonTrialState,
  Contact,
  DIFFICULTIES,
  DifficultySpec,
  Doctrine,
  FleetOrder,
  FleetOrderKind,
  Mine,
  MinefieldState,
  ManualControlToken,
  ManualCommand,
  FleetDirectives,
  EchoRidgeState,
  HostileDrone,
  FleetNetworkState,
  NetworkMessage,
  UnitLinkState,
  CrownState,
  MissionPhase,
  Objective,
  Projectile,
  SecurityNode,
  SimEvent,
  Unit,
  Vec3,
  dist3,
  distXZ,
  vec3
} from "../types";
import { generateMission, MissionSpec } from "../world/mission";
import { Navigator } from "./navigation";
import { cloneTask, computeSeparation, createFleet, spec, stepMovement } from "./units";
import { Rng } from "../rng";
import { consume, subsystemFactor, transfer } from "../logistics/domain";

export type CoreState = "atFacility" | "carried" | "dropped";
export type Outcome = "won" | "lost";

let projId = 0;
const midpointV=(a:Vec3,b:Vec3):Vec3=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2,z:(a.z+b.z)/2});

export class Simulation {
  readonly mission: MissionSpec;
  readonly nav: Navigator;
  readonly difficulty: DifficultySpec;
  readonly rng: Rng;

  units: Unit[];
  nodes: SecurityNode[];
  mines: Mine[];
  projectiles: Projectile[] = [];
  contacts = new Map<string, Contact>();
  objectives: Objective[];
  phase: MissionPhase = "deploy";
  now = 0;
  timeRemaining: number;
  doctrine: Doctrine = "balanced";
  fleetOrder: FleetOrder | null = null;
  events: SimEvent[] = [];
  coreState: CoreState = "atFacility";
  corePos: Vec3 | null = null;
  carrierId: string | null = null;
  facilityRevealed = false;
  outcome: Outcome | null = null;
  loseReason = "";
  /** order refusal message surfaced to UI, cleared after a few seconds */
  orderRefusal: { text: string; until: number } | null = null;
  canyonTrial: CanyonTrialState | null = null;
  minefield: MinefieldState | null = null;
  manualOwnerId: string | null = null;
  private manualSession = 0;
  directives:FleetDirectives={formation:"auto",speed:"auto",depth:"auto",emissions:"auto",cohesion:"together",risk:"balanced"};
  echoRidge:EchoRidgeState|null=null;
  hostileDrones:HostileDrone[]=[];
  network:FleetNetworkState;
  private networkAccumulator=0;
  private networkMessageId=0;
  silentDivideState: import("../types").SilentDivideState|null=null;
  crown:CrownState|null=null;

  onEvent: ((e: SimEvent) => void) | null = null;

  private warnedStorm = false;
  private warnedBattery = new Set<string>();
  private detectionAccumulator = 0;
  logisticsPolicy: import("../types").LogisticsPolicy={conservation:"balanced",minimumReserve:20,authorizeScarce:true};
  logisticsEvents: import("../types").LogisticsEvent[]=[];

  constructor(seed: number, difficultyId: "easy" | "normal" | "hard", mission?: MissionSpec) {
    this.difficulty = DIFFICULTIES.find((d) => d.id === difficultyId) ?? DIFFICULTIES[1];
    this.mission = mission ?? generateMission(seed, difficultyId);
    this.nav = new Navigator(this.mission.terrain);
    this.rng = new Rng(seed ^ 0xfe2d);
    this.units = createFleet(this.mission.deployment, 0);
    this.nodes = this.mission.nodes;
    this.mines = this.mission.mines;
    this.objectives = this.mission.objectives;
    this.timeRemaining = this.difficulty.timeLimit;
    this.network={policy:"auto",posture:"balanced",links:new Map(),messages:[],relays:[],topologyRevision:0,jammerActive:false,jammerDetected:false,jammerPos:vec3()};
    for(const u of this.units)this.network.links.set(u.id,{unitId:u.id,state:"linked",quality:1,latency:0,route:["unit-ATLAS",u.id],lastTransition:0,telemetryAt:0,lastKnownPos:{...u.pos},uncertainty:0,lastAck:null,fallback:"hold",pendingState:null,pendingSince:0});
    if (this.mission.canyonTrial) {
      this.canyonTrial = {
        status: "running",
        priority: "safest",
        coordination: "together",
        clearanceMargin: 6,
        speedLimit: 7,
        held: false,
        obstructionIntroduced: false,
        completedUnitIds: new Set(),
        startedAt: 0
      };
      this.phase = "approach";
      this.timeRemaining = Number.POSITIVE_INFINITY;
    }
    if (this.mission.silentMinefield) {
      this.minefield = {
        status: "scan", posture: "balanced", policy: "avoid", formation: "auto", clearance: 38,
        scanStarted: false, crossingStarted: false, held: false, retreat: false,
        neutralizationAuthorized: false, neutralizationCancelled: false, driftingReleased: false,
        contacts: new Map(), completedUnitIds: new Set(), selectedContactId: null,
        replans: 0, emergencyHolds: 0, startedAt: 0
      };
      this.phase = "approach";
      this.timeRemaining = Number.POSITIVE_INFINITY;
    }
    if(this.mission.echoRidge){this.echoRidge={phase:"approach",alert:"normal",roe:"defensive",protection:"auto",posture:"balanced",countermeasurePolicy:"threatened",withdrawalThreshold:45,formation:"auto",contacts:new Map(),packageState:"station",carrierId:null,reinforcementIntroduced:false,revision:0,countermeasures:4,countermeasureCooldownUntil:0,interceptorsLaunched:0,startedAt:0};this.hostileDrones=this.mission.echoRidge.droneSpawns.map(s=>({id:s.id,role:s.role,pos:{...s.pos},prevPos:{...s.pos},heading:s.heading,speed:0,maxSpeed:s.role==="recon"?14:s.role==="pursuit"?17:11,sensorRange:s.role==="recon"?520:s.role==="pursuit"?420:380,hull:s.role==="attack"?100:s.role==="pursuit"?70:45,state:"patrol",targetId:null,lastKnownTargetPos:null,suspicion:0,weaponCooldownUntil:0,ammunition:s.role==="attack"?3:s.role==="pursuit"?2:1,spawnedAt:0}));this.phase="approach";this.timeRemaining=900;}
    if(this.mission.silentDivide){this.network.jammerPos={...this.mission.silentDivide.jammerPos};this.phase="approach";this.timeRemaining=1500;this.silentDivideState={phase:"relays",routeId:"reliable",assignmentRevision:1,relayTargetIndex:0,unitRoutes:new Map()};for(const link of this.network.links.values())link.fallback="continueThenHold";}
    if(this.mission.abyssalCrown){this.crown={phase:"insertion",phaseEnteredAt:0,revision:1,canyonChoice:"safe",networkChoice:"relay",mineChoice:"bypass",defenseChoice:"evade",extractionChoice:"primary",completed:new Set(),optional:{samples:false,avoidEngagements:true,relayRecovered:false,probeRescued:false,allOperational:true,beforeDeadline:true},recoveries:0,lastProgressAt:0,terminalReason:"",cinematicCue:"deployment"};this.timeRemaining=this.mission.abyssalCrown.deadline;this.phase="approach";}
  }

  // ---------------------------------------------------------------- helpers

  emit(kind: SimEvent["kind"], text: string, pos: Vec3 | null = null, unitId: string | null = null) {
    const e: SimEvent = { time: this.now, kind, text, pos, unitId };
    this.events.push(e);
    if (this.events.length > 80) this.events.splice(0, this.events.length - 80);
    this.onEvent?.(e);
  }

  unit(id: string): Unit | undefined {
    return this.units.find((u) => u.id === id);
  }

  objective(kind: Objective["kind"]): Objective {
    return this.objectives.find((o) => o.kind === kind)!;
  }

  aliveUnits(): Unit[] {
    return this.units.filter((u) => u.state !== "destroyed");
  }

  mobileUnits(): Unit[] {
    return this.units.filter((u) => u.state === "active");
  }

  carrier(): Unit | undefined {
    return this.carrierId ? this.unit(this.carrierId) : undefined;
  }

  /** Danger cost for pathfinding, built from KNOWN contacts only. */
  dangerAt(x: number, z: number): number {
    const aversion = DOCTRINE[this.doctrine].dangerAversion;
    let d = 0;
    for (const c of this.contacts.values()) {
      if (c.kind === "securityNode") {
        const node = this.nodes.find((n) => n.id === c.refId);
        if (!node || node.state === "disabled" || node.state === "destroyed") continue;
        const r = node.detectRadius * 1.15;
        const dd = Math.hypot(x - c.pos.x, z - c.pos.z);
        if (dd < r) {
          const t = 1 - dd / r;
          d += t * t * 6 * aversion;
        }
      } else if (c.kind === "mine") {
        const dd = Math.hypot(x - c.pos.x, z - c.pos.z);
        if (dd < 80) {
          const t = 1 - dd / 80;
          d += t * t * 9 * aversion;
        }
      }
    }
    return d;
  }

  /** Known hostile contacts near a position (for stand-off reasoning). */
  knownThreatsNear(pos: Vec3, radius: number): Contact[] {
    const out: Contact[] = [];
    for (const c of this.contacts.values()) {
      if (c.kind !== "securityNode" && c.kind !== "mine") continue;
      if (distXZ(c.pos, pos) < radius + c.uncertainty) out.push(c);
    }
    return out;
  }

  // ------------------------------------------------------------ player input

  setDoctrine(d: Doctrine) {
    if (this.doctrine === d) return;
    this.doctrine = d;
    this.emit("phaseChange", `Doctrine set to ${DOCTRINE[d].label}.`);
  }

  updateTrialSettings(settings: Partial<Pick<CanyonTrialState, "priority" | "coordination" | "clearanceMargin" | "speedLimit" | "held">>) {
    if (!this.canyonTrial || this.canyonTrial.status !== "running") return;
    Object.assign(this.canyonTrial, settings);
    this.emit("phaseChange", "Obstacle-navigation constraints updated; NEREUS is re-evaluating routes.");
  }

  updateMinefieldSettings(settings: Partial<Pick<MinefieldState, "posture" | "policy" | "formation" | "clearance" | "held" | "scanStarted" | "crossingStarted" | "retreat" | "neutralizationAuthorized" | "neutralizationCancelled">>) {
    if (!this.minefield || this.minefield.status === "complete") return;
    Object.assign(this.minefield, settings);
    if (settings.retreat) this.minefield.status = "retreating";
    else if (settings.crossingStarted) this.minefield.status = "crossing";
    this.emit("phaseChange", "Threat-response constraints updated; NEREUS is re-evaluating the minefield.");
  }

  acquireManualControl(unitId:string,assistance:"standard"|"warnings"="standard"):ManualControlToken|null{
    const u=this.unit(unitId),link=this.network.links.get(unitId);if(!u||u.state!=="active"||this.manualOwnerId||link?.state==="disconnected")return null;
    const suspended={task:cloneTask(u.task),speedOrder:u.speedOrder,interactProgress:u.interactProgress,suspendedAt:this.now};
    const session=++this.manualSession;u.control={mode:"manual",session,command:{heading:u.heading,depth:u.depth,throttle:u.speed,updatedAt:this.now},suspended,assistance,correction:null};u.interactProgress=0;this.manualOwnerId=u.id;
    this.emit("phaseChange",`${u.callsign} transferred to Manual Intervention. NEREUS is replanning the remaining fleet.`,{...u.pos},u.id);return{unitId:u.id,session};
  }

  setManualCommand(token:ManualControlToken,command:Partial<ManualCommand>):boolean{
    const u=this.unit(token.unitId);if(!u||u.control.mode!=="manual"||u.control.session!==token.session)return false;
    const link=this.network.links.get(u.id);if(!link||link.state==="disconnected")return false;this.queueNetworkMessage("operator",u.id,"manual",80,1,0,token.session);Object.assign(u.control.command,command,{updatedAt:this.now});return true;
  }

  releaseManualControl(token:ManualControlToken):boolean{
    const u=this.unit(token.unitId);if(!u||u.control.mode!=="manual"||u.control.session!==token.session)return false;
    u.control={mode:"recovering",suspended:u.control.suspended,releasedAt:this.now};u.task={kind:"hold",pos:{...u.pos},targetId:`recovery-${u.id}`,committedAt:this.now,commitUntil:this.now+1,path:[],pathIndex:0,desc:"returning to NEREUS"};u.speedOrder=0;this.manualOwnerId=null;this.emit("phaseChange",`${u.callsign} returned to NEREUS; autonomous recovery route requested.`,{...u.pos},u.id);return true;
  }

  switchManualControl(token:ManualControlToken,newUnitId:string):ManualControlToken|null{if(!this.releaseManualControl(token))return null;return this.acquireManualControl(newUnitId);}
  updateFleetDirectives(next:Partial<FleetDirectives>){Object.assign(this.directives,next);this.emit("phaseChange","Fleet directives updated; NEREUS is validating the requested constraints.");}
  updateLogisticsPolicy(next:Partial<import("../types").LogisticsPolicy>){Object.assign(this.logisticsPolicy,next);this.emit("phaseChange","Logistics policy updated; NEREUS recalculated reserves.");}
  transferSupply(fromId:string,toId:string,key:keyof import("../types").LogisticsInventory,amount:number){const from=this.unit(fromId),to=this.unit(toId);if(!from||!to||!transfer(from,to,key,amount))return false;this.logisticsEvents.push({time:this.now,unitId:from.id,resource:key,amount:-amount,reason:`transferred to ${to.callsign}`},{time:this.now,unitId:to.id,resource:key,amount,reason:`received from ${from.callsign}`});if(this.logisticsEvents.length>80)this.logisticsEvents.splice(0,this.logisticsEvents.length-80);return true;}
  recoverRelay(unitId:string,relayId:string){const u=this.unit(unitId),relay=this.network.relays.find(r=>r.id===relayId&&r.active);if(!u||!relay||distXZ(u.pos,relay.pos)>35||u.speed>=1||u.logistics.relays>=u.logistics.relayCapacity)return false;relay.active=false;u.logistics.relays++;this.network.topologyRevision++;return true;}
  updateNetworkPolicy(policy:FleetNetworkState["policy"],posture:FleetNetworkState["posture"]){this.network.policy=policy;this.network.posture=posture;this.emit("phaseChange","Fleet network policy updated.");}
  setFallback(unitId:string,fallback:UnitLinkState["fallback"]){const link=this.network.links.get(unitId);if(link)link.fallback=fallback;}
  deployRelay(unitId:string):boolean{const u=this.unit(unitId);if(!u||u.state!=="active"||this.network.relays.filter(r=>r.active).length>=3||!consume(u.logistics,"relays",1,this.logisticsPolicy.authorizeScarce?0:1))return false;const relay={id:`relay-${this.network.relays.length+1}`,pos:{...u.pos},range:(u.role==="ECHO"?700:480)*subsystemFactor(u,"communications",.25),energy:100,active:true,deployedBy:u.id};this.network.relays.push(relay);this.network.topologyRevision++;this.emit("phaseChange",`${u.callsign} deployed communication relay ${relay.id}.`,{...u.pos},u.id);return true;}
  activateUnknownJammer(){if(!this.mission.silentDivide||this.network.jammerActive)return false;this.network.jammerActive=true;this.emit("phaseChange","Unknown interference source activated inside Silent Divide.",{...this.network.jammerPos});return true;}
  queueNetworkMessage(sender:string,receiver:string,kind:NetworkMessage["kind"],priority:number,ttl:number,assignmentVersion=0,controlSession:number|null=null){const link=this.network.links.get(receiver),route=link?.route??[],latency=link?.latency??5;const message:NetworkMessage={id:`net-${++this.networkMessageId}`,sender,receiver,createdAt:this.now,deliverAt:this.now+latency,priority,expiresAt:this.now+ttl,acknowledged:false,assignmentVersion,controlSession,state:route.length?"transmitting":"queued",route:[...route],kind};this.network.messages.push(message);if(this.network.messages.length>120)this.network.messages.splice(0,this.network.messages.length-120);return message;}
  updateDefenseSettings(next:Partial<Pick<EchoRidgeState,"roe"|"protection"|"posture"|"countermeasurePolicy"|"withdrawalThreshold"|"formation">>){if(!this.echoRidge)return;Object.assign(this.echoRidge,next);this.echoRidge.revision++;this.emit("phaseChange","Defensive policies updated; NEREUS is reassessing the threat picture.");}
  introduceReinforcement(){if(!this.echoRidge||this.echoRidge.reinforcementIntroduced||!this.mission.echoRidge)return false;const p=this.mission.echoRidge.reinforcementSpawn;this.hostileDrones.push({id:"H-04",role:"pursuit",pos:{...p},prevPos:{...p},heading:Math.PI,speed:8,maxSpeed:17,sensorRange:420,hull:70,state:"patrol",targetId:null,lastKnownTargetPos:null,suspicion:0,weaponCooldownUntil:0,ammunition:2,spawnedAt:this.now});this.echoRidge.reinforcementIntroduced=true;this.emit("phaseChange","Hostile reinforcement introduced outside fleet sensor range.");return true;}
  launchDefensiveInterceptor(targetId:string):boolean{const state=this.echoRidge,lancer=this.units.find(u=>u.role==="LANCER"),track=state?.contacts.get(targetId),drone=this.hostileDrones.find(d=>d.id===targetId);if(!state||!lancer||!track||!drone||lancer.state!=="active"||lancer.torpedoes<=0||track.classification!=="hostile"||state.roe==="evade")return false;if(this.units.some(u=>u.id!==lancer.id&&distXZ(u.pos,drone.pos)<85))return false;const d=dist3(lancer.pos,drone.pos)||1;lancer.torpedoes--;state.interceptorsLaunched++;this.projectiles.push({id:`interceptor-${projId++}`,pos:{...lancer.pos},prevPos:{...lancer.pos},vel:vec3((drone.pos.x-lancer.pos.x)/d*50,(drone.pos.y-lancer.pos.y)/d*50,(drone.pos.z-lancer.pos.z)/d*50),targetId:`drone:${drone.id}`,fromNodeId:lancer.id,launchedAt:this.now,ttl:16,done:false,hit:false});this.emit("warning",`Lancer launched defensive interceptor at ${drone.id}.`,{...lancer.pos},lancer.id);return true;}
  deployCountermeasure(unitId:string):boolean{const state=this.echoRidge,u=this.unit(unitId);if(!state||!u||u.state!=="active"||state.countermeasures<=0||this.now<state.countermeasureCooldownUntil)return false;state.countermeasures--;state.countermeasureCooldownUntil=this.now+18;for(const drone of this.hostileDrones)if(distXZ(drone.pos,u.pos)<320){drone.suspicion=Math.max(0,drone.suspicion-.55);if(drone.state==="track"||drone.state==="attack")drone.state="evade";}this.emit("jam",`${u.callsign} deployed an acoustic decoy.`,{...u.pos},u.id);return true;}

  releaseDriftingMine(): boolean {
    const state=this.minefield, spec=this.mission.silentMinefield;
    if(!state||!spec||state.driftingReleased) return false;
    const truth=spec.contacts.find(c=>c.isMine && c.corridorId==="alpha")!;
    truth.drifting=true; truth.velocity={x:0,y:0,z:7}; state.driftingReleased=true;
    const mine=this.mines.find(m=>m.id===truth.id); if(mine) mine.pos={...truth.pos};
    this.emit("phaseChange", "Training control released a drifting mine ahead of the fleet.", {...truth.pos});
    return true;
  }

  neutralizeMine(contactId: string): boolean {
    const state=this.minefield, spec=this.mission.silentMinefield;
    if(!state||!spec||!state.neutralizationAuthorized||state.neutralizationCancelled) return false;
    const c=state.contacts.get(contactId); const truth=spec.contacts.find(x=>x.id===contactId);
    const mine=this.mines.find(m=>m.id===contactId); const lancer=this.units.find(u=>u.role==="LANCER");
    if(!c||!truth||!mine||!lancer||c.classification!=="mine"||!mine.armed||lancer.torpedoes<=0) return false;
    if(this.units.some(u=>u.id!==lancer.id&&u.state!=="destroyed"&&distXZ(u.pos,mine.pos)<mine.damageRadius+40)) return false;
    mine.armed=false; c.disabled=true; c.classification="disabled"; lancer.torpedoes--;
    this.emit("nodeDisabled", `${contactId} disabled by Lancer's fictional neutralization device.`, {...mine.pos}, lancer.id);
    return true;
  }

  introduceTrialObstruction(): boolean {
    const spec = this.mission.canyonTrial;
    const trial = this.canyonTrial;
    if (!spec || !trial || trial.obstructionIntroduced) return false;
    trial.obstructionIntroduced = true;
    const narrowUnit = this.units.find((u) => u.state === "active" && u.task.corridorId === "narrow");
    if (narrowUnit) {
      const waypoint = narrowUnit.task.path[narrowUnit.task.pathIndex] ?? spec.rockfall.pos;
      const dx = waypoint.x - narrowUnit.pos.x;
      const dz = waypoint.z - narrowUnit.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      const ahead = Math.min(220, Math.max(140, d * 0.55));
      spec.rockfall.pos = {
        x: narrowUnit.pos.x + (dx / d) * ahead,
        y: narrowUnit.pos.y,
        z: narrowUnit.pos.z + (dz / d) * ahead
      };
    }
    spec.rockfall.active = true;
    this.emit("phaseChange", "Rockfall introduced ahead of the fleet; sensors are checking the passage.", { ...spec.rockfall.pos });
    return true;
  }

  validateOrder(kind: FleetOrderKind): string | null {
    const mobile = this.mobileUnits();
    if (mobile.length === 0) return "No submarine is able to maneuver.";
    if (kind === "investigate" && !mobile.some((u) => u.role === "GHOST" || u.role === "ECHO")) {
      return "No reconnaissance-capable submarine remains (Ghost or Echo required).";
    }
    if (kind === "repairs") {
      const mender = this.units.find((u) => u.role === "MENDER");
      if (!mender || mender.state === "destroyed") return "Mender is lost — field repairs are impossible.";
      if (mender.state !== "active") return "Mender is disabled and cannot perform repairs.";
      if (mender.repairKits <= 0) return "Mender's repair supplies are exhausted.";
      if (!this.aliveUnits().some((u) => u.hull < spec(u.role).hull * 0.95)) return "No submarine currently needs repair.";
    }
    if (kind === "extract" && this.coreState === "atFacility") {
      return "The data core is still at the facility — extraction now would forfeit the mission.";
    }
    return null;
  }

  issueOrder(kind: FleetOrderKind, pos: Vec3 | null = null, targetId: string | null = null): boolean {
    if (this.canyonTrial) {
      const text = "Fleet orders are suspended during Canyon Passage training; use the obstacle controls.";
      this.orderRefusal = { text, until: this.now + 5 };
      this.emit("warning", `Order refused: ${text}`);
      return false;
    }
    const refusal = this.validateOrder(kind);
    if (refusal) {
      this.orderRefusal = { text: refusal, until: this.now + 5 };
      this.emit("warning", `Order refused: ${refusal}`);
      return false;
    }
    this.fleetOrder = { kind, pos, targetId, issuedAt: this.now };
    const label =
      kind === "advance"
        ? "Fleet order: advance on the marked position."
        : kind === "regroup"
          ? "Fleet order: regroup on Atlas."
          : kind === "hold"
            ? "Fleet order: hold positions."
            : kind === "repairs"
              ? "Fleet order: prioritize repairs."
              : kind === "investigate"
                ? "Fleet order: investigate the marked contact."
                : "Fleet order: proceed to extraction.";
    this.emit("phaseChange", label);
    return true;
  }

  clearOrder() {
    this.fleetOrder = null;
    this.emit("phaseChange", "Fleet order cleared — NEREUS resumes mission plan.");
  }

  ping(unitId: string): boolean {
    const u = this.unit(unitId);
    if (!u || u.state !== "active") return false;
    if (this.now < u.sonarActiveUntil - DETECTION.PING_DURATION + DETECTION.PING_COOLDOWN||u.subsystems.sensors.integrity<.2||!consume(u.logistics,"energy",2,this.logisticsPolicy.minimumReserve)) return false;
    u.sonarActiveUntil = this.now + DETECTION.PING_DURATION;
    this.emit("ping", `${u.callsign} active sonar ping.`, { ...u.pos }, u.id);
    return true;
  }

  jam(unitId: string): boolean {
    const u = this.unit(unitId);
    if (!u || u.role !== "ECHO" || u.state !== "active") return false;
    if (this.now < u.jamCooldownUntil||!consume(u.logistics,"counterJamming",1,0)||!consume(u.logistics,"energy",4,this.logisticsPolicy.minimumReserve)) return false;
    u.jamUntil = this.now + DETECTION.JAM_DURATION;
    u.jamCooldownUntil = this.now + DETECTION.JAM_COOLDOWN;
    this.emit("jam", `${u.callsign} jamming hostile sensors.`, { ...u.pos }, u.id);
    return true;
  }

  // ------------------------------------------------------------- simulation

  step() {
    if (this.outcome) return;
    const dt = SIM.DT;
    this.now += dt;
    this.networkAccumulator+=dt;if(this.networkAccumulator>=.25){this.networkAccumulator=0;this.stepNetwork();}
    if (!this.canyonTrial && !this.minefield) this.timeRemaining -= dt;

    // --- movement ---
    const hazards: { pos: Vec3; radius: number }[] = [];
    for (const c of this.contacts.values()) {
      if (c.kind === "mine") hazards.push({ pos: c.pos, radius: 70 });
    }
    if (this.mission.canyonTrial) {
      for (const o of [...this.mission.canyonTrial.barrier, this.mission.canyonTrial.rockfall]) {
        if (o.active && o.discovered) hazards.push({ pos: o.pos, radius: o.radius + 20 });
      }
    }
    for (const u of this.units) {
      const sep = computeSeparation(u, this.units, hazards);
      stepMovement(u, dt, this.mission.terrain, sep);
      // ping noise boost
      if (this.now < u.sonarActiveUntil) u.noise += DETECTION.PING_NOISE_BOOST;
    }
    for(const u of this.units){if(u.control.mode==="manual"){this.applyManualSafety(u);}else if(u.control.mode==="recovering"&&this.now-u.control.releasedAt>.25){u.control={mode:"autonomous"};}}

    // --- battery ---
    for (const u of this.units) {
      if (u.state !== "active") continue;
      const s = spec(u.role);
      const ratio = u.speed / s.maxSpeed;
      const spent=(0.03 + 0.2 * ratio * ratio) * this.difficulty.batteryDrainMul * dt;u.logistics.energy=Math.max(0,u.logistics.energy-spent);u.battery=(u.logistics.energy/u.logistics.energyCapacity)*100;
      if (u.battery < 30 && !this.warnedBattery.has(u.id)) {
        this.warnedBattery.add(u.id);
        this.emit("warning", `${u.callsign} battery below 30%.`, { ...u.pos }, u.id);
      }
    }

    // --- stuck detection ---
    for (const u of this.units) {
      if (u.state !== "active") continue;
      if (this.now - u.stuckCheckAt >= SIM.STUCK_INTERVAL) {
        const moved = distXZ(u.pos, u.lastPosForStuck);
        const wantsMove = u.task.path.length > 0 && u.targetSpeed > 1;
        u.stuckCheckAt = this.now;
        u.lastPosForStuck = { ...u.pos };
        if (wantsMove && moved < SIM.STUCK_DIST) {
          u.stuckTime += SIM.STUCK_INTERVAL;
          if (u.stuckTime >= SIM.STUCK_INTERVAL * 2) {
            u.stuckTime = 0;
            // nudge: recompute path with slightly raised danger aversion
            const goal = u.task.path[u.task.path.length - 1] ?? u.task.pos;
            if (goal) {
              const p = this.nav.findPath(u.pos, goal, (x, z) => this.dangerAt(x, z) + 0.4);
              if (p) {
                u.task.path = p;
                u.task.pathIndex = 0;
              }
            }
            this.emit("stuck", `${u.callsign} rerouting (path blocked).`, { ...u.pos }, u.id);
          }
        } else {
          u.stuckTime = 0;
        }
      }
    }

    // --- detection (4 Hz) ---
    this.detectionAccumulator += dt;
    if (this.detectionAccumulator >= 0.25) {
      this.detectionAccumulator = 0;
      this.stepDetection();
    }

    // --- node behavior ---
    this.stepNodes(dt);

    // --- projectiles ---
    if(this.echoRidge)this.stepEchoRidge(dt);
    this.stepProjectiles(dt);

    // --- mines ---
    if (this.minefield) this.stepMinefieldTruth(dt);
    this.stepMines();

    // --- interactions (survey / recover / repair / extraction) ---
    this.stepInteractions(dt);

    // --- mission clock & outcome ---
    if (this.canyonTrial) this.stepCanyonTrial();
    if (this.minefield) this.stepMinefieldProgress();
    if(this.mission.silentDivide)this.stepSilentDivide();
    if(this.crown)this.stepAbyssalCrown();
    if (!this.canyonTrial && !this.minefield && !this.warnedStorm && this.timeRemaining < SCORING.STORM_WARN_AT) {
      this.warnedStorm = true;
      this.emit("warning", `Storm closing — ${Math.round(this.timeRemaining)} seconds to extraction deadline.`);
    }
    if (!this.canyonTrial && !this.minefield&&!this.echoRidge) this.checkOutcome();
  }

  // ---------------------------------------------------------------- sensing

  private senseRange(u: Unit): number {
    const s = spec(u.role);
    return (this.now < u.sonarActiveUntil ? s.activeRange : s.passiveRange)*subsystemFactor(u,"sensors",.3);
  }

  private stepDetection() {
    const t = this.mission.terrain;
    const trialSpec = this.mission.canyonTrial;
    for (const u of this.units) {
      if (u.state === "destroyed") continue;
      const range = this.senseRange(u);
      if (this.minefield?.scanStarted && this.mission.silentMinefield) this.observeMinefield(u, range);
      if (trialSpec && !trialSpec.barrier.every((o) => o.discovered)) {
        const observed = trialSpec.barrier.some((o) => dist3(u.pos, o.pos) < range);
        if (observed) {
          for (const o of trialSpec.barrier) o.discovered = true;
          this.emit("contact", `${u.callsign} mapped the Canyon Passage barrier and both candidate routes.`, { ...u.pos }, u.id);
        }
      }
      if (trialSpec?.rockfall.active && !trialSpec.rockfall.discovered && dist3(u.pos, trialSpec.rockfall.pos) < range) {
        trialSpec.rockfall.discovered = true;
        this.emit("contact", `${u.callsign} detected a rockfall blocking Narrow Cut.`, { ...trialSpec.rockfall.pos }, u.id);
      }
      for (const n of this.nodes) {
        if (n.state === "destroyed" || n.state === "disabled") {
          // still visible as wrecks once found, but no longer a threat
        }
        const d = dist3(u.pos, n.pos);
        if (d < range && !t.losBlocked(u.pos, n.pos)) {
          this.seeContact(`c-${n.id}`, "securityNode", n.pos, n.id);
        }
      }
      const mineRange = u.role === "ECHO" ? 250 : 150;
      for (const m of this.mines) {
        if (m.detonated) continue;
        const d = dist3(u.pos, m.pos);
        if (d < mineRange && !t.losBlocked(u.pos, m.pos)) {
          this.seeContact(`c-${m.id}`, "mine", m.pos, m.id);
        }
      }
      // discovering the facility by proximity
      if (!this.facilityRevealed && distXZ(u.pos, this.mission.facilityPos) < 420) {
        this.revealFacility();
      }
    }
    // decay confirmation & grow uncertainty
    for (const c of this.contacts.values()) {
      if (this.now - c.lastSeenAt > 2) c.confirmed = false;
      if (!c.confirmed) c.uncertainty = Math.min(220, c.uncertainty + DETECTION.UNCERTAINTY_GROWTH * 0.25);
    }
  }

  private seeContact(id: string, kind: Contact["kind"], pos: Vec3, refId: string) {
    const existing = this.contacts.get(id);
    if (existing) {
      existing.pos = { ...pos };
      existing.uncertainty = kind === "mine" ? 12 : 20;
      existing.lastSeenAt = this.now;
      existing.confirmed = true;
      return;
    }
    this.contacts.set(id, {
      id,
      kind,
      pos: { ...pos },
      uncertainty: kind === "mine" ? 12 : 20,
      lastSeenAt: this.now,
      confirmed: true,
      refId
    });
    this.emit(
      "contact",
      kind === "securityNode" ? "New contact: automated security node." : "New contact: naval mine.",
      { ...pos }
    );
  }

  private revealFacility() {
    if (this.facilityRevealed) return;
    this.facilityRevealed = true;
    this.emit("objectiveDone", "Research facility located.", { ...this.mission.facilityPos });
    this.setPhase(this.phase === "survey" || this.phase === "deploy" ? "recovery" : this.phase);
  }

  setPhase(p: MissionPhase) {
    if (this.phase === p) return;
    this.phase = p;
    const msg =
      p === "survey"
        ? "Phase: survey both canyon routes."
        : p === "recovery"
          ? "Phase: recover the data core from the facility."
          : p === "escort"
            ? "Phase: escort the core to extraction."
            : "";
    if (msg) this.emit("phaseChange", msg);
  }

  // ------------------------------------------------------------------ nodes

  private stepNodes(dt: number) {
    const t = this.mission.terrain;
    for (const n of this.nodes) {
      if (n.state === "disabled" || n.state === "destroyed") continue;

      // jamming suppresses detection
      let jammed = this.now < n.jammedUntil;
      if (!jammed) {
        for (const u of this.units) {
          if (u.role === "ECHO" && u.state === "active" && this.now < u.jamUntil) {
            if (dist3(u.pos, n.pos) < DETECTION.JAM_RADIUS) {
              n.jammedUntil = this.now + 0.5;
              jammed = true;
              break;
            }
          }
        }
      }

      // find the loudest visible unit
      let best: Unit | null = null;
      let bestScore = 0;
      if (!jammed) {
        for (const u of this.units) {
          if (u.state !== "active") continue;
          const d = dist3(u.pos, n.pos);
          const noiseFactor = Math.max(0.35, Math.min(1.7, u.noise / DETECTION.NOISE_REFERENCE));
          const effR = n.detectRadius * noiseFactor * this.difficulty.detectMul;
          if (d < effR && !t.losBlocked(n.pos, u.pos)) {
            const score = 1 - d / effR;
            if (score > bestScore) {
              bestScore = score;
              best = u;
            }
          }
        }
      }

      if (n.state === "cooldown") {
        if (this.now >= n.cooldownUntil) {
          n.state = "dormant";
          n.suspicion = 0;
          n.suspicionTarget = null;
        }
        continue;
      }

      if (best) {
        n.suspicionTarget = best.id;
        n.suspicion = Math.min(1, n.suspicion + DETECTION.SUSPICION_RATE * (0.4 + bestScore) * dt);
        if (n.suspicion >= 1 && n.state !== "alert") {
          n.state = "alert";
          this.emit("nodeAlert", "Security node alerted — weapons hot.", { ...n.pos });
        }
      } else {
        n.suspicion = Math.max(0, n.suspicion - DETECTION.SUSPICION_DECAY * dt);
        if (n.state === "alert") {
          const target = n.suspicionTarget ? this.unit(n.suspicionTarget) : null;
          const targetGone =
            !target || target.state !== "active" || dist3(target.pos, n.pos) > n.detectRadius * 1.3;
          if (targetGone) {
            n.state = "cooldown";
            n.cooldownUntil = this.now + DETECTION.ALERT_TIME;
            n.suspicion = 0.5;
          }
        }
      }

      // fire
      if (n.state === "alert" && n.suspicionTarget && this.now >= n.fireCooldownUntil) {
        const target = this.unit(n.suspicionTarget);
        if (
          target &&
          target.state === "active" &&
          dist3(target.pos, n.pos) < n.detectRadius * COMBAT.NODE_FIRE_RANGE_FACTOR * this.difficulty.detectMul &&
          !t.losBlocked(n.pos, target.pos)
        ) {
          n.fireCooldownUntil = this.now + DETECTION.FIRE_COOLDOWN;
          // lead the target slightly
          const tof = dist3(target.pos, n.pos) / COMBAT.NODE_PROJECTILE_SPEED;
          const aim = vec3(
            target.pos.x + Math.sin(target.heading) * target.speed * tof * 0.7,
            target.pos.y,
            target.pos.z + Math.cos(target.heading) * target.speed * tof * 0.7
          );
          const dir = vec3(aim.x - n.pos.x, aim.y - n.pos.y, aim.z - n.pos.z);
          const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
          this.projectiles.push({
            id: `proj${projId++}`,
            pos: { ...n.pos },
            prevPos: { ...n.pos },
            vel: vec3(
              (dir.x / len) * COMBAT.NODE_PROJECTILE_SPEED,
              (dir.y / len) * COMBAT.NODE_PROJECTILE_SPEED,
              (dir.z / len) * COMBAT.NODE_PROJECTILE_SPEED
            ),
            targetId: target.id,
            fromNodeId: n.id,
            launchedAt: this.now,
            ttl: 20,
            done: false,
            hit: false
          });
          this.emit("warning", `${target.callsign} under fire.`, { ...target.pos }, target.id);
        }
      }
    }
  }

  private stepProjectiles(dt: number) {
    for (const p of this.projectiles) {
      if (p.done) continue;
      p.prevPos = { ...p.pos };
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
      p.ttl -= dt;
      if(p.targetId.startsWith("drone:")){const drone=this.hostileDrones.find(d=>d.id===p.targetId.slice(6));if(drone&&dist3(p.pos,drone.pos)<18){p.done=true;p.hit=true;drone.hull-=55;drone.state=drone.hull<=0?"destroyed":"retreat";const c=this.echoRidge?.contacts.get(drone.id);if(c){c.classification=drone.state==="destroyed"?"destroyed":"retreating";c.damageState=drone.hull<=0?"destroyed":"damaged";}this.emit("torpedoHit",`Defensive interceptor hit ${drone.id}.`,{...drone.pos});continue;}}
      const target = this.unit(p.targetId);
      if (target && target.state !== "destroyed" && dist3(p.pos, target.pos) < 16) {
        p.done = true;
        p.hit = true;
        this.damageUnit(target, COMBAT.NODE_PROJECTILE_DAMAGE, "security fire");
        continue;
      }
      if (p.ttl <= 0 || p.pos.y < this.mission.terrain.seabedY(p.pos.x, p.pos.z)) {
        p.done = true;
        this.emit("torpedoHit", "Projectile impacted the seabed.", { ...p.pos });
      }
    }
    if (this.projectiles.length > 40) this.projectiles = this.projectiles.filter((p) => !p.done);
  }

  private stepMines() {
    for (const m of this.mines) {
      if (m.detonated || !m.armed) continue;
      for (const u of this.units) {
        if (u.state === "destroyed") continue;
        if (dist3(u.pos, m.pos) < m.triggerRadius) {
          m.detonated = true;
          this.emit("mineHit", "Mine detonated.", { ...m.pos });
          for (const v of this.units) {
            if (v.state === "destroyed") continue;
            const d = dist3(v.pos, m.pos);
            if (d < m.damageRadius) {
              const falloff = 1 - (d / m.damageRadius) * 0.6;
              this.damageUnit(v, COMBAT.MINE_DAMAGE * falloff, "mine detonation");
            }
          }
          const c = this.contacts.get(`c-${m.id}`);
          if (c) this.contacts.delete(`c-${m.id}`);
          break;
        }
      }
    }
  }

  damageUnit(u: Unit, amount: number, cause: string) {
    if (u.state === "destroyed") return;
    const dmg = amount * this.difficulty.damageMul;
    const before = u.state;
    u.hull = Math.max(0, u.hull - dmg);
    if(u.hull>0){const order:import("../types").SubsystemId[]=cause.includes("mine")?["propulsion","communications","sensors","weapons","repair"]:["sensors","weapons","propulsion","communications","repair"];const idx=Math.abs([...`${u.id}:${cause}:${Math.round(this.now)}`].reduce((a,c)=>a*31+c.charCodeAt(0),0))%order.length,target=order[idx];u.subsystems[target].integrity=Math.max(0,u.subsystems[target].integrity-dmg/spec(u.role).hull*.55);u.subsystems[target].lastDamagedAt=this.now;if(u.subsystems.propulsion.integrity<.15)u.state="disabled";}
    this.emit("unitDamaged", `${u.callsign} hit by ${cause} — hull ${Math.round(u.hull)}%.`, { ...u.pos }, u.id);
    if (u.hull <= 0) {
      u.state = "destroyed";
      u.speed = 0;
      this.emit("unitDestroyed", `${u.callsign} destroyed.`, { ...u.pos }, u.id);
      this.dropCoreFrom(u);
    } else if (u.hull <= COMBAT.DISABLED_HULL && before === "active") {
      u.state = "disabled";
      u.speed = 0;
      u.targetSpeed = 0;
      this.emit("unitDisabled", `${u.callsign} disabled — dead in the water.`, { ...u.pos }, u.id);
      this.dropCoreFrom(u);
    }
  }

  private dropCoreFrom(u: Unit) {
    if (!u.hasCore) return;
    u.hasCore = false;
    this.coreState = "dropped";
    this.corePos = { ...u.pos };
    this.carrierId = null;
    this.emit("coreDropped", "Data core dropped — another submarine can retrieve it.", { ...u.pos });
  }

  /** LANCER (or any attacker) fires at a security node. */
  fireTorpedo(u: Unit, nodeId: string): boolean {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node || u.torpedoes <= 0 || u.state !== "active") return false;
    if (node.state === "disabled" || node.state === "destroyed") return false;
    if (dist3(u.pos, node.pos) > COMBAT.TORPEDO_RANGE) return false;
    if (this.mission.terrain.losBlocked(u.pos, node.pos)) return false;
    u.torpedoes--;
    const dir = vec3(node.pos.x - u.pos.x, node.pos.y - u.pos.y, node.pos.z - u.pos.z);
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    this.projectiles.push({
      id: `proj${projId++}`,
      pos: { ...u.pos },
      prevPos: { ...u.pos },
      vel: vec3(
        (dir.x / len) * COMBAT.TORPEDO_SPEED,
        (dir.y / len) * COMBAT.TORPEDO_SPEED,
        (dir.z / len) * COMBAT.TORPEDO_SPEED
      ),
      targetId: `node:${node.id}`,
      fromNodeId: u.id,
      launchedAt: this.now,
      ttl: COMBAT.TORPEDO_TTL,
      done: false,
      hit: false
    });
    this.emit("warning", `${u.callsign} fired on a security node.`, { ...u.pos }, u.id);
    return true;
  }

  private stepTorpedoHits() {
    for (const p of this.projectiles) {
      if (p.done || !p.targetId.startsWith("node:")) continue;
      const node = this.nodes.find((n) => n.id === p.targetId.slice(5));
      if (!node) {
        p.done = true;
        continue;
      }
      if (dist3(p.pos, node.pos) < 18) {
        p.done = true;
        p.hit = true;
        node.hp--;
        this.emit("torpedoHit", "Torpedo impact on security node.", { ...node.pos });
        if (node.hp <= 0) {
          node.state = "disabled";
          this.emit("nodeDisabled", "Security node disabled.", { ...node.pos });
          const c = this.contacts.get(`c-${node.id}`);
          if (c) c.kind = "wreck";
        }
      }
    }
  }

  // ------------------------------------------------------------ interactions

  private stepInteractions(dt: number) {
    // torpedo-vs-node hits handled here (projectiles vs units in stepProjectiles)
    this.stepTorpedoHits();

    for (const u of this.units) {
      if (u.state !== "active") continue;
      const task = u.task;

      if (this.canyonTrial) continue;

      // surveys (dwell on station to complete the scan)
      if ((task.kind === "survey" || task.kind === "scout") && task.targetId) {
        const obj = this.objectives.find((o) => o.id === task.targetId);
        if (obj && !obj.done && distXZ(u.pos, obj.pos) < 95) {
          obj.progress = Math.min(1, obj.progress + dt / COMBAT.SURVEY_TIME);
          if (obj.progress >= 1) {
            obj.done = true;
            this.emit("objectiveDone", `${obj.label} — complete.`, { ...obj.pos }, u.id);
            if (this.objective("surveyA").done && this.objective("surveyB").done) {
              this.revealFacility();
            }
          }
        }
      }

      // recover core at facility
      if (task.kind === "recover" && this.coreState === "atFacility") {
        if (distXZ(u.pos, this.mission.facilityPos) < COMBAT.INTERACT_RANGE && u.speed < 3) {
          const need = u.role === "MENDER" ? COMBAT.RECOVER_TIME : COMBAT.RECOVER_TIME_SLOW;
          u.interactProgress += dt / need;
          if (u.interactProgress >= 1) {
            u.interactProgress = 0;
            this.coreState = "carried";
            this.carrierId = u.id;
            u.hasCore = true;
            const fo = this.objective("facility");
            fo.done = true;
            fo.progress = 1;
            this.emit("coreRecovered", `${u.callsign} has recovered the data core.`, { ...u.pos }, u.id);
            this.setPhase("escort");
          }
        } else if (u.interactProgress > 0) {
          u.interactProgress = Math.max(0, u.interactProgress - dt * 0.05);
        }
      }

      // fetch dropped core
      if (task.kind === "fetchcore" && this.coreState === "dropped" && this.corePos) {
        if (dist3(u.pos, this.corePos) < COMBAT.INTERACT_RANGE && u.speed < 3) {
          const need = u.role === "MENDER" ? COMBAT.FETCH_TIME_MENDER : COMBAT.FETCH_TIME;
          u.interactProgress += dt / need;
          if (u.interactProgress >= 1) {
            u.interactProgress = 0;
            this.coreState = "carried";
            this.carrierId = u.id;
            u.hasCore = true;
            this.corePos = null;
            this.emit("coreRecovered", `${u.callsign} retrieved the data core.`, { ...u.pos }, u.id);
          }
        }
      }

      // repairs
      if (task.kind === "repair" && task.targetId && u.role === "MENDER" && u.repairKits > 0) {
        const target = this.unit(task.targetId);
        if (target && target.state !== "destroyed" && dist3(u.pos, target.pos) < COMBAT.REPAIR_RANGE) {
          const s = spec(target.role);
          const need = target.hull < s.hull * 0.7 && target.state !== "active" ? true : target.hull < s.hull * 0.85;
          if (need) {
            target.hull = Math.min(s.hull * 0.85, target.hull + COMBAT.REPAIR_RATE * dt);
            u.interactProgress += (COMBAT.REPAIR_RATE * dt) / COMBAT.REPAIR_AMOUNT;
            if (u.interactProgress >= 1) {
              u.interactProgress = 0;
              u.repairKits--;
              this.emit("repairDone", `${u.callsign} completed a repair cycle on ${target.callsign}.`, { ...target.pos }, u.id);
            }
            if (target.state === "disabled" && target.hull > COMBAT.DISABLED_HULL + 8) {
              target.state = "active";
              this.emit("repairDone", `${target.callsign} is underway again.`, { ...target.pos }, target.id);
            }
          }
        }
      }
    }

    // --- win check: core + 3 units inside extraction ---
    const ext = this.mission.extractionPos;
    const carrier = this.carrier();
    if (this.coreState === "carried" && carrier && carrier.state !== "destroyed" && distXZ(carrier.pos, ext) < 150) {
      const inside = this.aliveUnits().filter((u) => distXZ(u.pos, ext) < 150);
      if (inside.length >= SCORING.SURVIVORS_REQUIRED) {
        this.outcome = "won";
        this.emit("phaseChange", "Mission complete — core delivered, fleet extracted.");
      }
    }
  }

  private checkOutcome() {
    if (this.outcome) return;
    const alive = this.aliveUnits();
    if (alive.length < SCORING.SURVIVORS_REQUIRED) {
      this.outcome = "lost";
      this.loseReason = "Fewer than three submarines remain.";
      return;
    }
    if (alive.every((u) => u.state !== "active")) {
      this.outcome = "lost";
      this.loseReason = "All remaining submarines are disabled and cannot reach extraction.";
      return;
    }
    const mobile = this.mobileUnits();
    if (mobile.length > 0 && mobile.every((u) => u.battery <= 0.5)) {
      this.outcome = "lost";
      this.loseReason = "The fleet is adrift — batteries exhausted.";
      return;
    }
    if (!this.canyonTrial && this.timeRemaining <= 0) {
      this.outcome = "lost";
      this.loseReason = "The storm closed the recovery window.";
    }
  }

  private stepCanyonTrial() {
    const trial = this.canyonTrial;
    const spec = this.mission.canyonTrial;
    if (!trial || !spec || trial.status !== "running") return;
    for (const u of this.units) {
      if (u.state === "destroyed" || trial.completedUnitIds.has(u.id)) continue;
      if (distXZ(u.pos, spec.regroupPoint) < 95) {
        trial.completedUnitIds.add(u.id);
        this.emit("objectiveDone", `${u.callsign} cleared Canyon Passage and reached the regroup area.`, { ...u.pos }, u.id);
      }
    }
    if (trial.completedUnitIds.size === this.units.length) {
      trial.status = "complete";
      this.objectives[0].done = true;
      this.outcome = "won";
      this.emit("phaseChange", "Canyon Passage complete — all five submarines regrouped safely.", { ...spec.regroupPoint });
    }
  }

  private observeMinefield(u: Unit, range: number) {
    const state=this.minefield!, spec=this.mission.silentMinefield!;
    const postureMul=state.posture==="passive"?.55:state.posture==="maximum"?1.45:1;
    const active=this.now<u.sonarActiveUntil;
    const capability=u.role==="ECHO"?1.5:u.role==="GHOST"?1.25:u.role==="ATLAS"?1.05:.75;
    for(const truth of spec.contacts){
      const d=dist3(u.pos,truth.pos); if(d>range*postureMul||this.mission.terrain.losBlocked(u.pos,truth.pos)) continue;
      let c=state.contacts.get(truth.id);
      if(!c){
        const jitter=Math.max(18,Math.min(120,d*.18));
        c={id:truth.id,estimate:{x:truth.pos.x+jitter*.35,y:truth.pos.y,z:truth.pos.z-jitter*.25},uncertainty:jitter,classification:"unknown",evidence:0,detectingUnitId:u.id,method:active?"active":"passive",lastUpdate:this.now,estimatedMoving:false,corridorId:truth.corridorId,disabled:false};
        state.contacts.set(c.id,c); this.emit("contact",`Unknown sonar return ${c.id} detected.`,{...c.estimate},u.id);
      }
      const gain=(active?.15:.045)*capability*(1-d/Math.max(1,range*postureMul));
      const before=c.classification; c.evidence=Math.min(1,c.evidence+Math.max(.01,gain)); c.lastUpdate=this.now; c.detectingUnitId=u.id; c.method=active?"active":"passive";
      c.uncertainty=Math.max(8,c.uncertainty-(active?5:1.5)*capability); c.estimate={...truth.pos};
      c.estimatedMoving=truth.drifting;
      c.classification=c.evidence<.18?"unknown":c.evidence<.38?"possibleHazard":c.evidence<.68?"probableMine":truth.isMine?"mine":"decoy";
      if(before!==c.classification) this.emit("contact",`${c.id} reclassified: ${c.classification}.`,{...c.estimate},u.id);
    }
  }

  private stepMinefieldTruth(dt:number){
    const spec=this.mission.silentMinefield!;
    for(const truth of spec.contacts){
      if(!truth.drifting) continue;
      truth.pos.x+=truth.velocity.x*dt; truth.pos.z+=truth.velocity.z*dt;
      const mine=this.mines.find(m=>m.id===truth.id); if(mine) mine.pos={...truth.pos};
      const known=this.minefield!.contacts.get(truth.id);
      if(known&&distXZ(known.estimate,truth.pos)>35){ known.classification=known.classification==="decoy"?"decoy":"lost"; known.uncertainty=Math.min(240,known.uncertainty+dt*10); }
    }
    for(const c of this.minefield!.contacts.values()) if(this.now-c.lastUpdate>5&&!c.disabled){
      c.classification=c.classification==="decoy"?"decoy":c.classification==="mine"&&!c.estimatedMoving?"mine":"lost";
      c.uncertainty=Math.min(240,c.uncertainty+dt*5);
    }
  }

  private stepMinefieldProgress(){
    const state=this.minefield!, course=this.mission.silentMinefield!;
    for(const u of this.units){
      if(u.state!=="destroyed"&&distXZ(u.pos,course.regroupPoint)<105) state.completedUnitIds.add(u.id);
      for(const c of state.contacts.values()){
        if(c.disabled||!["probableMine","mine","lost"].includes(c.classification)) continue;
        const assigned=u.task.corridorId==="outer"?"bravo":u.task.corridorId==="narrow"?"alpha":null;
        if(!assigned||c.corridorId!==assigned) continue;
        const radius=34+c.uncertainty+state.clearance+spec(u.role).radius;
        const d=distXZ(u.pos,c.estimate);
        if(d<radius+90&&u.state==="active"){
          u.speedOrder=0; u.task.speedLimit=Math.min(u.task.speedLimit??99,2);
          if(d<radius+25&&u.stuckTime===0){ state.emergencyHolds++; u.stuckTime=.01; this.emit("warning",`${u.callsign} emergency braking near ${c.id}.`,{...u.pos},u.id); }
        }
      }
    }
    if(state.completedUnitIds.size===this.units.length){state.status="complete";this.objectives[0].done=true;this.outcome="won";this.emit("phaseChange","Silent Minefield complete — fleet regrouped and threat assessment closed.",{...course.regroupPoint});}
  }

  private applyManualSafety(u:Unit){if(u.control.mode!=="manual")return;u.control.correction=null;const floor=this.mission.terrain.seabedY(u.pos.x,u.pos.z)+WORLD.SEABED_MARGIN,ceil=-WORLD.SURFACE_MARGIN;if(u.pos.y<floor+8){u.control.correction="Terrain avoidance: ascending";u.control.command.depth=Math.max(WORLD.SURFACE_MARGIN,-floor-24);u.control.command.throttle=Math.min(u.control.command.throttle,spec(u.role).silentSpeed);}if(u.pos.y>ceil-4){u.control.correction="Surface limit";u.control.command.depth=WORLD.SURFACE_MARGIN+8;}if(u.control.assistance==="standard"){for(const c of this.contacts.values()){if(c.kind!=="mine")continue;const stop=(u.speed*u.speed)/(2*Math.max(1,spec(u.role).accel));if(distXZ(u.pos,c.pos)<c.uncertainty+70+stop){u.control.command.throttle=0;u.control.correction=`Emergency braking near ${c.id}`;break;}}}}

  private stepEchoRidge(dt:number){const state=this.echoRidge!,ridge=this.mission.echoRidge!;let alert:EchoRidgeState["alert"]="normal";
    for(const drone of this.hostileDrones){if(drone.state==="destroyed"||drone.state==="disabled")continue;drone.prevPos={...drone.pos};let sensed:Unit|null=null,best=Infinity;for(const u of this.units){if(u.state==="destroyed")continue;const d=dist3(u.pos,drone.pos),noisy=u.noise>18||this.now<u.sonarActiveUntil;if(d<drone.sensorRange*(noisy?1.25:.65)&&!this.mission.terrain.losBlocked(drone.pos,u.pos)&&d<best){best=d;sensed=u;}}
      if(sensed){drone.suspicion=Math.min(1,drone.suspicion+dt*.18);drone.targetId=sensed.id;drone.lastKnownTargetPos={...sensed.pos};if(drone.suspicion>.35)drone.state="track";if(drone.suspicion>.75&&best<340)drone.state="attack";}else{drone.suspicion=Math.max(0,drone.suspicion-dt*.04);if(drone.lastKnownTargetPos)drone.state="search";}
      const goal=drone.lastKnownTargetPos??ridge.station,delta=Math.atan2(goal.x-drone.pos.x,goal.z-drone.pos.z)-drone.heading;drone.heading+=Math.max(-.55*dt,Math.min(.55*dt,Math.atan2(Math.sin(delta),Math.cos(delta))));const wanted=drone.state==="attack"?drone.maxSpeed:drone.state==="track"?drone.maxSpeed*.85:drone.maxSpeed*.45;drone.speed+=(wanted-drone.speed)*Math.min(1,dt*1.2);drone.pos.x+=Math.sin(drone.heading)*drone.speed*dt;drone.pos.z+=Math.cos(drone.heading)*drone.speed*dt;
      for(const u of this.units){if(u.state==="destroyed")continue;const range=this.now<u.sonarActiveUntil?spec(u.role).activeRange:spec(u.role).passiveRange;if(dist3(u.pos,drone.pos)<range&&!this.mission.terrain.losBlocked(u.pos,drone.pos)){let c=state.contacts.get(drone.id);if(!c){c={id:drone.id,estimate:{...drone.pos},uncertainty:100,classification:"unknownMobile",evidence:0,heading:drone.heading,speed:drone.speed,lastDetected:this.now,detectingUnitId:u.id,behavior:"moving return",suspectedTargetId:null,damageState:"intact"};state.contacts.set(c.id,c);this.emit("contact",`Unknown mobile contact ${c.id} detected.`,{...c.estimate},u.id);}const before=c.classification;c.evidence=Math.min(1,c.evidence+(this.now<u.sonarActiveUntil?.12:.035)*(u.role==="ECHO"?1.6:u.role==="GHOST"?1.3:1));c.estimate={...drone.pos};c.uncertainty=Math.max(12,c.uncertainty-2);c.heading=drone.heading;c.speed=drone.speed;c.lastDetected=this.now;c.behavior=drone.state;c.suspectedTargetId=drone.targetId;c.classification=c.evidence<.2?"unknownMobile":c.evidence<.4?"possibleVehicle":c.evidence<.6?"vehicle":drone.state==="attack"?"hostile":"suspectedHostile";if(before!==c.classification)this.emit("contact",`${c.id} reclassified: ${c.classification}.`,{...c.estimate},u.id);}}
      if(drone.state==="attack"){alert="defensive";if(this.now>=drone.weaponCooldownUntil&&drone.targetId&&drone.ammunition>0){const target=this.unit(drone.targetId);if(target){drone.weaponCooldownUntil=this.now+12;drone.ammunition--;const d=dist3(drone.pos,target.pos)||1;this.projectiles.push({id:`hostile-${projId++}`,pos:{...drone.pos},prevPos:{...drone.pos},vel:vec3((target.pos.x-drone.pos.x)/d*32,(target.pos.y-drone.pos.y)/d*32,(target.pos.z-drone.pos.z)/d*32),targetId:target.id,fromNodeId:drone.id,launchedAt:this.now,ttl:18,done:false,hit:false});this.emit("warning",`Incoming hostile projectile targeting ${target.callsign}.`,{...drone.pos},target.id);}}}else if(drone.state==="track")alert=alert==="normal"?"alert":alert;else if(state.contacts.has(drone.id)&&alert==="normal")alert="watch";
    }
    if(alert!==state.alert){state.alert=alert;state.revision++;this.emit("phaseChange",`Defensive alert changed to ${alert.toUpperCase()}.`);}
    if(state.packageState==="station"){const carrier=this.units.find(u=>u.role==="MENDER"&&u.state==="active"&&u.logistics.objectiveCapacity>0)??this.units.find(u=>u.state==="active"&&u.logistics.objectiveCapacity>0);if(carrier&&distXZ(carrier.pos,ridge.packagePos)<55){state.packageState="carried";state.carrierId=carrier.id;carrier.hasCore=true;this.emit("coreRecovered",`${carrier.callsign} recovered the Echo Ridge sensor package.`,{...carrier.pos},carrier.id);}}
    const carrier=state.carrierId?this.unit(state.carrierId):null;if(carrier&&distXZ(carrier.pos,ridge.extraction)<140){state.packageState="delivered";const inside=this.aliveUnits().filter(u=>distXZ(u.pos,ridge.extraction)<160);if(inside.length>=3&&!this.projectiles.some(p=>!p.done&&p.fromNodeId.startsWith("H-"))){state.phase="complete";this.outcome="won";this.emit("phaseChange","Echo Ridge secured — package and surviving fleet extracted.");}}
  }

  /** current objective text for HUD */
  private stepNetwork(){const atlas=this.units.find(u=>u.role==="ATLAS"&&u.state!=="destroyed");if(!atlas)return;const nodes=[...this.units.filter(u=>u.state!=="destroyed").map(u=>({id:u.id,pos:u.pos,range:this.mission.silentDivide?(u.role==="ATLAS"?850:u.role==="ECHO"?760:430):(u.role==="ATLAS"?3600:u.role==="ECHO"?3200:2600),unit:u})),...this.network.relays.filter(r=>r.active&&r.energy>0).map(r=>({id:r.id,pos:r.pos,range:r.range,unit:null as Unit|null}))];const edge=(a:typeof nodes[number],b:typeof nodes[number])=>{const d=distXZ(a.pos,b.pos),range=Math.min(a.range,b.range);let q=Math.max(0,1-d/range);if(this.mission.silentDivide&&this.mission.terrain.losBlocked(a.pos,b.pos))q*=.28;if(this.mission.silentDivide&&distXZ(midpointV(a.pos,b.pos),this.mission.silentDivide.deadZoneCenter)<this.mission.silentDivide.deadZoneRadius)q*=.35;if(this.network.jammerActive&&distXZ(midpointV(a.pos,b.pos),this.network.jammerPos)<360)q*=.18;return q;};for(const unit of this.units){const link=this.network.links.get(unit.id)!;if(unit.id===atlas.id){link.quality=1;link.route=[atlas.id];link.state="linked";link.telemetryAt=this.now;link.lastKnownPos={...unit.pos};continue;}let bestRoute:string[]=[],bestQ=0;const root=nodes.find(n=>n.id===atlas.id)!,target=nodes.find(n=>n.id===unit.id);if(!target){link.state="disconnected";link.quality=0;link.route=[];continue;}const direct=edge(root,target);if(direct>bestQ){bestQ=direct;bestRoute=[atlas.id,unit.id];}for(const relay of nodes.filter(n=>n.id!==atlas.id&&n.id!==unit.id)){const q=Math.min(edge(root,relay),edge(relay,target));if(q>bestQ){bestQ=q;bestRoute=[atlas.id,relay.id,unit.id];}}const previous=link.state;link.quality=bestQ;link.latency=.12+bestRoute.length*.18+(1-bestQ)*2;link.route=bestQ>.18?bestRoute:[];const thresholdDown=previous==="linked"||previous==="degraded"?.32:.48;let next:UnitLinkState["state"]=previous;if(bestQ>=.58)next=previous==="disconnected"?"reconnecting":previous==="reconnecting"?"synchronizing":"linked";else if(bestQ>=thresholdDown)next="degraded";else next="disconnected";if(next!==previous){if(link.pendingState!==next){link.pendingState=next;link.pendingSince=this.now;}const required=next==="disconnected"?1.5:.75;if(this.now-link.pendingSince>=required){link.state=next;link.pendingState=null;link.lastTransition=this.now;this.network.topologyRevision++;this.emit("phaseChange",`${unit.callsign} network state: ${next}.`,{...link.lastKnownPos},unit.id);}}else{link.pendingState=null;}if(next!=="disconnected"){link.telemetryAt=this.now;link.lastKnownPos={...unit.pos};link.uncertainty=Math.max(0,link.uncertainty-12);}else{link.uncertainty=Math.min(500,link.uncertainty+4);this.applyFallback(unit,link);if(this.manualOwnerId===unit.id&&unit.control.mode==="manual"){this.releaseManualControl({unitId:unit.id,session:unit.control.session});this.emit("warning",`${unit.callsign}: LINK LOST — LOCAL FALLBACK.`,{...unit.pos},unit.id);}}}this.network.messages.sort((a,b)=>b.priority-a.priority);for(const message of this.network.messages){if(["delivered","expired","failed","superseded"].includes(message.state))continue;if(this.now>message.expiresAt){message.state="expired";continue;}const link=this.network.links.get(message.receiver);if(!link||link.state==="disconnected"){message.state="delayed";continue;}if(message.controlSession!==null){const u=this.unit(message.receiver);if(!u||u.control.mode!=="manual"||u.control.session!==message.controlSession){message.state="superseded";continue;}}if(this.now>=message.deliverAt){message.state="delivered";message.acknowledged=true;link.lastAck=message.id;}else message.state=message.route.length>2?"relayed":"transmitting";}for(const relay of this.network.relays)if(relay.active){relay.energy=Math.max(0,relay.energy-.015);if(relay.energy===0)relay.active=false;}}

  private applyFallback(unit:Unit,link:UnitLinkState){if(unit.state!=="active")return;if(link.fallback==="hold"){unit.task={kind:"hold",pos:{...unit.pos},targetId:`fallback-${unit.id}`,committedAt:this.now,commitUntil:this.now+5,path:[],pathIndex:0,desc:"local fallback · hold"};unit.speedOrder=0;}else if(link.fallback==="retrace"){const goal=this.mission.deployment[this.units.indexOf(unit)];unit.task={kind:"transit",pos:{...goal},targetId:`fallback-${unit.id}`,committedAt:this.now,commitUntil:this.now+5,path:[{...goal}],pathIndex:0,desc:"local fallback · retrace"};}else if(link.fallback==="continueThenHold"){if(!unit.task.desc?.startsWith("local fallback"))unit.task.desc=`local fallback · continuing ${unit.task.desc??"route"}`;if(this.now-link.lastTransition>(unit.task.corridorId?.startsWith("network-relay")?90:45)){unit.task={kind:"hold",pos:{...unit.pos},targetId:`fallback-${unit.id}`,committedAt:this.now,commitUntil:this.now+5,path:[],pathIndex:0,desc:"local fallback · route grace expired"};unit.speedOrder=0;}return;}else if(link.fallback==="rally"){const goal=this.mission.extractionPos;unit.task={kind:"transit",pos:{...goal},targetId:`fallback-${unit.id}`,committedAt:this.now,commitUntil:this.now+5,path:[{...goal}],pathIndex:0,desc:"local fallback · rally"};}}

  private stepSilentDivide(){const divide=this.mission.silentDivide!;if(this.coreState==="atFacility"){const carrier=this.units.find(u=>u.role==="MENDER"&&u.state==="active");if(carrier&&distXZ(carrier.pos,divide.blackBoxPos)<120){this.coreState="carried";this.carrierId=carrier.id;carrier.hasCore=true;this.objectives[0].done=true;const carrierLink=this.network.links.get(carrier.id);if(carrierLink)carrierLink.fallback="rally";this.emit("coreRecovered",`${carrier.callsign} recovered the Silent Divide black box.`,{...carrier.pos},carrier.id);}}const carrier=this.carrierId?this.unit(this.carrierId):null;if(carrier&&distXZ(carrier.pos,divide.extraction)<145){const inside=this.aliveUnits().filter(u=>distXZ(u.pos,divide.extraction)<165);if(inside.length>=3){this.outcome="won";this.emit("phaseChange","Silent Divide complete — black box and fleet extracted.");}}if(this.network.jammerActive&&!this.network.jammerDetected){const echo=this.units.find(u=>u.role==="ECHO");if(echo&&distXZ(echo.pos,this.network.jammerPos)<spec(echo.role).activeRange){this.network.jammerDetected=true;this.emit("contact","Unknown interference source classified as dormant jammer.",{...this.network.jammerPos},echo.id);}}}

  private stepAbyssalCrown(){const state=this.crown!,s=this.mission.abyssalCrown!;if(this.outcome)return;const elapsed=this.now-state.phaseEnteredAt,alive=this.aliveUnits();if(alive.length<3){state.phase="failed";state.terminalReason="Fewer than three submarines survive.";this.outcome="lost";this.loseReason=state.terminalReason;return;}const checkpoint=s.checkpoints[state.phase as Exclude<import("../types").CrownPhase,"complete"|"failed">],reached=checkpoint?alive.filter(u=>distXZ(u.pos,checkpoint)<150).length>=Math.min(3,alive.length):false;const advance=(next:import("../types").CrownPhase,cue:string)=>{state.completed.add(state.phase);state.phase=next;state.phaseEnteredAt=this.now;state.lastProgressAt=this.now;state.revision++;state.cinematicCue=cue;this.emit("phaseChange",`Operation Abyssal Crown: ${next} phase.`,checkpoint?{...checkpoint}:null);};if(state.phase==="insertion"&&(reached||elapsed>55))advance("canyon","canyon-entry");else if(state.phase==="canyon"&&(reached||elapsed>240))advance("network","network-divide");else if(state.phase==="network"&&(this.network.relays.some(r=>r.active)||state.networkChoice==="planned"||elapsed>210))advance("minefield","minefield-reveal");else if(state.phase==="minefield"&&(reached||elapsed>260))advance("defense","hostile-reveal");else if(state.phase==="defense"&&(reached||elapsed>220))advance("core","facility-reveal");else if(state.phase==="core"&&this.coreState==="atFacility"){const carrier=this.units.find(u=>u.role==="MENDER"&&u.state==="active")??this.mobileUnits()[0];if(carrier&&distXZ(carrier.pos,s.facility)<100){this.coreState="carried";this.carrierId=carrier.id;carrier.hasCore=true;this.objectives[0].done=true;this.emit("coreRecovered",`${carrier.callsign} recovered the Abyssal Crown data core.`,{...carrier.pos},carrier.id);advance("extraction","core-recovery");}}else if(state.phase==="extraction"){const extraction=state.extractionChoice==="primary"?s.primaryExtraction:s.alternateExtraction,carrier=this.carrierId?this.unit(this.carrierId):null;if(carrier&&distXZ(carrier.pos,extraction)<160&&alive.filter(u=>distXZ(u.pos,extraction)<175).length>=3){state.phase="complete";state.completed.add("extraction");state.optional.allOperational=alive.length===5;state.optional.beforeDeadline=this.timeRemaining>0;this.outcome="won";state.cinematicCue="final-extraction";this.emit("phaseChange","Operation Abyssal Crown complete — core delivered and fleet extracted.",{...extraction});}}if(this.now>=s.encounterAt.jammer&&!this.network.jammerActive&&state.phase!=="insertion")this.network.jammerActive=true;if(this.timeRemaining<=0&&!this.outcome){state.phase="failed";state.terminalReason="Storm window expired.";this.outcome="lost";this.loseReason=state.terminalReason;}}

  objectiveText(): string {
    if(this.crown)return `Operation Abyssal Crown · ${this.crown.phase.toUpperCase()} · ${this.coreState==="carried"?"Core secured":"Core pending"}`;
    if(this.mission.silentDivide)return this.coreState==="atFacility"?"Recover the black box inside Silent Divide.":"Maintain network reach and escort the black box to extraction.";
    if(this.echoRidge)return this.echoRidge.phase==="complete"?"Echo Ridge secured — package extracted.":this.echoRidge.packageState==="station"?"Recover the Echo Ridge sensor package.":"Escort the sensor package and surviving fleet to extraction.";
    if (this.canyonTrial) {
      const done = this.canyonTrial.completedUnitIds.size;
      return this.canyonTrial.status === "complete"
        ? "Canyon Passage complete — fleet regrouped."
        : `Canyon Passage — guide and regroup all five submarines (${done}/5).`;
    }
    if (this.minefield) {
      const done=this.minefield.completedUnitIds.size;
      return this.minefield.status==="complete" ? "Silent Minefield complete — fleet regrouped." : `Silent Minefield — classify, cross, and regroup (${done}/5).`;
    }
    switch (this.phase) {
      case "deploy":
        return "Deploy the fleet — NEREUS is forming up.";
      case "survey": {
        const a = this.objective("surveyA").done ? "✓" : "…";
        const b = this.objective("surveyB").done ? "✓" : "…";
        return `Survey canyon routes  N:${a}  S:${b}`;
      }
      case "recovery":
        return this.coreState === "dropped"
          ? "Retrieve the dropped data core."
          : "Recover the data core from the research facility.";
      case "escort":
        return "Escort the core carrier to extraction.";
      case "won":
        return "Mission complete.";
      case "lost":
        return "Mission failed.";
      default:
        return "";
    }
  }
}
