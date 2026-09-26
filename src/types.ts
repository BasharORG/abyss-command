/** Core typed models shared by simulation, commander, rendering, and UI. */

export type Vec3 = { x: number; y: number; z: number };

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function cloneV(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}
export function distXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.hypot(dx, dz);
}
export function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.hypot(dx, dy, dz);
}

export type Role = "ATLAS" | "GHOST" | "LANCER" | "ECHO" | "MENDER";

export const ROLES: readonly Role[] = ["ATLAS", "GHOST", "LANCER", "ECHO", "MENDER"] as const;

export type UnitState = "active" | "disabled" | "destroyed";

export type TaskKind =
  | "idle"
  | "hold"
  | "scout" // survey a route / point of interest
  | "survey" // survey objective beacon
  | "escort" // stay near a protected ally
  | "repair" // MENDER repairing an ally
  | "support" // damaged ally holding behind cover awaiting repair
  | "attack" // LANCER disabling a security node
  | "distract" // draw a security node's attention
  | "jam" // ECHO area jamming support
  | "recover" // MENDER (or substitute) retrieving the data core
  | "fetchcore" // retrieve a dropped core
  | "exfil" // proceed to extraction
  | "regroup"
  | "investigate"
  | "transit" // obstacle-trial passage assignment
  | "rescue"; // MENDER moving to aid a disabled ally

export interface UnitTask {
  kind: TaskKind;
  /** target position if relevant */
  pos: Vec3 | null;
  /** target entity id (unit id, node id, objective id) if relevant */
  targetId: string | null;
  /** sim time when this task was committed */
  committedAt: number;
  /** do not replan away from this task before this time unless forced */
  commitUntil: number;
  /** waypoint path in world space (excluding current pos) */
  path: Vec3[];
  pathIndex: number;
  /** human-readable description from the commander ("surveying the north canyon") */
  desc?: string;
  /** speed order assigned with this task (NEREUS may temporarily lower it near threats) */
  speedOrder?: number;
  /** exact movement ceiling for constrained passages */
  speedLimit?: number;
  /** obstacle-trial route metadata, when applicable */
  corridorId?: string;
  routeRevision?: number;
}

export interface ManualCommand {
  heading: number;
  depth: number;
  throttle: number;
  updatedAt: number;
}

export interface SuspendedAssignment {
  task: UnitTask;
  speedOrder: number;
  interactProgress: number;
  suspendedAt: number;
}

export type UnitControl =
  | { mode: "autonomous" }
  | { mode: "manual"; session: number; command: ManualCommand; suspended: SuspendedAssignment; assistance: "standard" | "warnings"; correction: string | null }
  | { mode: "recovering"; suspended: SuspendedAssignment; releasedAt: number };

export interface ManualControlToken { unitId: string; session: number }
export interface FleetDirectives {
  formation: "line"|"wedge"|"ring"|"search"|"escort"|"auto";
  speed: "silent"|"cruise"|"flank"|"slowest"|"auto";
  depth: "shallow"|"mid"|"deep"|"terrain"|"auto";
  emissions: "passive"|"needed"|"maximum"|"auto";
  cohesion: "together"|"groups"|"independent";
  risk: "conservative"|"balanced"|"mission";
}
export type SubsystemId="propulsion"|"sensors"|"communications"|"weapons"|"repair";
export interface SubsystemStatus{integrity:number;lastDamagedAt:number;}
export interface LogisticsInventory{energy:number;energyCapacity:number;repairKits:number;repairCapacity:number;interceptors:number;interceptorCapacity:number;decoys:number;decoyCapacity:number;relays:number;relayCapacity:number;sensorBoosts:number;counterJamming:number;recoveryGear:number;objectiveCapacity:number;batteryPacks:number;}
export interface LoadoutChoice{role:Role;emphasis:"balanced"|"endurance"|"mission";}
export interface LogisticsPolicy{conservation:"conserve"|"balanced"|"spend";minimumReserve:number;authorizeScarce:boolean;}
export interface LogisticsEvent{time:number;unitId:string;resource:keyof LogisticsInventory;amount:number;reason:string;}

export interface Unit {
  id: string;
  role: Role;
  callsign: string;
  hullNumber: string;
  state: UnitState;
  pos: Vec3;
  /** previous position for render interpolation */
  prevPos: Vec3;
  heading: number; // radians, yaw around Y (0 = +Z)
  prevHeading: number;
  pitch: number;
  prevPitch: number;
  bank: number;
  prevBank: number;
  yawRate: number;
  speed: number; // m/s current
  targetSpeed: number;
  verticalSpeed: number; // m/s depth rate actually applied (+ = descending), set by movement
  depth: number; // positive depth below surface, m (derived from -y)
  /** heading the movement controller is steering toward (rad), null when no steering command */
  cmdHeading: number | null;
  /** depth the movement controller is easing toward (m), null when no vertical command */
  cmdDepth: number | null;
  /** yaw rate actually applied this step (rad/s, + = starboard turn), 0 when not steering */
  turnCmd: number;
  hull: number; // 0..100
  battery: number; // 0..100
  noise: number; // current emitted noise 0..100+
  sonarActiveUntil: number; // sim time active ping boost ends
  jamUntil: number; // ECHO jam active until
  jamCooldownUntil: number;
  torpedoes: number; // LANCER ammo
  repairKits: number; // MENDER supplies
  hasCore: boolean;
  /** interact progress 0..1 for recovery operations */
  interactProgress: number;
  task: UnitTask;
  stuckTime: number;
  lastPosForStuck: Vec3;
  stuckCheckAt: number;
  speedOrder: number; // 0 = silent, 1 = standard, 2 = flank (from doctrine/task)
  detectedBy: Set<string>; // threat ids currently tracking this unit
  control: UnitControl;
  logistics: LogisticsInventory;
  subsystems: Record<SubsystemId,SubsystemStatus>;
}

export type ContactKind = "securityNode" | "mine" | "decoy" | "drone" | "projectile" | "wreck" | "unknown";
export type ContactClassification = "unknown" | "possibleHazard" | "probableMine" | "mine" | "decoy" | "lost" | "disabled";

export interface Contact {
  id: string;
  kind: ContactKind;
  /** best-known position (may be uncertain) */
  pos: Vec3;
  /** position uncertainty radius, m */
  uncertainty: number;
  lastSeenAt: number;
  /** whether any friendly unit currently has eyes on it */
  confirmed: boolean;
  refId: string; // id of the sim entity this contact mirrors
  classification?: ContactClassification;
  evidence?: number;
  detectingUnitId?: string | null;
  detectionMethod?: "passive" | "active" | "visual";
  estimatedVelocity?: Vec3 | null;
  corridorId?: "alpha" | "bravo" | null;
}

export type NodeState = "dormant" | "suspicious" | "alert" | "cooldown" | "disabled" | "destroyed";

export interface SecurityNode {
  id: string;
  pos: Vec3;
  state: NodeState;
  detectRadius: number;
  /** 0..1 progress toward alert while a contact is inside */
  suspicion: number;
  suspicionTarget: string | null; // unit id being tracked
  cooldownUntil: number;
  fireCooldownUntil: number;
  hp: number;
  jammedUntil: number;
}

export interface Mine {
  id: string;
  pos: Vec3;
  armed: boolean;
  detonated: boolean;
  triggerRadius: number;
  damageRadius: number;
}

export interface Projectile {
  id: string;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  targetId: string;
  fromNodeId: string;
  launchedAt: number;
  ttl: number;
  done: boolean;
  hit: boolean;
}

export type ObjectiveKind = "surveyA" | "surveyB" | "facility" | "extraction";

export interface Objective {
  id: string;
  kind: ObjectiveKind;
  pos: Vec3;
  label: string;
  done: boolean;
  /** dwell progress 0..1 for survey objectives */
  progress: number;
}

export type Doctrine = "silent" | "balanced" | "urgent";

export type MissionMode = "mission" | "canyonTrial" | "silentMinefield" | "echoRidge" | "silentDivide" | "abyssalCrown";
export type TrialPriority = "safest" | "fastest";
export type TrialCoordination = "together" | "split";
export type TrialRouteStatus = "available" | "blocked" | "unverified";
export type TrialExecutionState =
  | "scanning"
  | "waiting"
  | "entering"
  | "outer"
  | "braking"
  | "replanning"
  | "regrouping"
  | "complete";

export interface TrialObstacle {
  id: string;
  pos: Vec3;
  radius: number;
  discovered: boolean;
  active: boolean;
}

export interface TrialCorridor {
  id: "narrow" | "outer";
  name: string;
  width: number;
  points: Vec3[];
}

export interface CanyonTrialSpec {
  destination: Vec3;
  regroupPoint: Vec3;
  stagingSlots: Vec3[];
  corridors: TrialCorridor[];
  barrier: TrialObstacle[];
  rockfall: TrialObstacle;
}

export interface TrialRouteAssessment {
  corridorId: TrialCorridor["id"];
  distance: number;
  status: TrialRouteStatus;
  usableBy: Role[];
  requiredClearance: Partial<Record<Role, number>>;
  reason: string;
}

export interface TrialUnitPlan {
  unitId: string;
  corridorId: TrialCorridor["id"];
  sequence: number | null;
  state: TrialExecutionState;
  waitingFor: string | null;
  progress: number;
}

export interface TrialDecision {
  revision: number;
  assessments: TrialRouteAssessment[];
  units: TrialUnitPlan[];
  explanation: string;
  decidedAt: number;
  transitioning: boolean;
}

export interface CanyonTrialState {
  status: "running" | "complete" | "failed";
  priority: TrialPriority;
  coordination: TrialCoordination;
  clearanceMargin: number;
  speedLimit: number;
  held: boolean;
  obstructionIntroduced: boolean;
  completedUnitIds: Set<string>;
  startedAt: number;
}

export type DetectionPosture = "passive" | "balanced" | "maximum";
export type ThreatPolicy = "avoid" | "blockingOnly" | "shortest";
export type CrossingFormation = "single" | "paired" | "auto";

export interface MinefieldContactTruth {
  id: string;
  pos: Vec3;
  isMine: boolean;
  drifting: boolean;
  velocity: Vec3;
  corridorId: "alpha" | "bravo" | null;
}

export interface SilentMinefieldSpec {
  destination: Vec3;
  regroupPoint: Vec3;
  stagingSlots: Vec3[];
  corridors: { id: "alpha" | "bravo"; name: string; width: number; points: Vec3[] }[];
  contacts: MinefieldContactTruth[];
}

export interface MinefieldContact {
  id: string;
  estimate: Vec3;
  uncertainty: number;
  classification: ContactClassification;
  evidence: number;
  detectingUnitId: string | null;
  method: "passive" | "active" | "visual";
  lastUpdate: number;
  estimatedMoving: boolean;
  corridorId: "alpha" | "bravo" | null;
  disabled: boolean;
}

export interface MinefieldCorridorAssessment {
  corridorId: "alpha" | "bravo";
  name: string;
  distance: number;
  status: "unverified" | "scanning" | "valid" | "degraded" | "blocked";
  affectingContacts: string[];
  transitTime: number;
  reason: string;
}

export interface MinefieldState {
  status: "scan" | "ready" | "crossing" | "retreating" | "complete" | "failed";
  posture: DetectionPosture;
  policy: ThreatPolicy;
  formation: CrossingFormation;
  clearance: number;
  scanStarted: boolean;
  crossingStarted: boolean;
  held: boolean;
  retreat: boolean;
  neutralizationAuthorized: boolean;
  neutralizationCancelled: boolean;
  driftingReleased: boolean;
  contacts: Map<string, MinefieldContact>;
  completedUnitIds: Set<string>;
  selectedContactId: string | null;
  replans: number;
  emergencyHolds: number;
  startedAt: number;
}

export type DroneRole="recon"|"pursuit"|"attack";
export type DroneState="patrol"|"search"|"track"|"attack"|"evade"|"retreat"|"disabled"|"destroyed";
export interface HostileDrone {id:string;role:DroneRole;pos:Vec3;prevPos:Vec3;heading:number;speed:number;maxSpeed:number;sensorRange:number;hull:number;state:DroneState;targetId:string|null;lastKnownTargetPos:Vec3|null;suspicion:number;weaponCooldownUntil:number;ammunition:number;spawnedAt:number;}
export type MobileClassification="unknownMobile"|"possibleVehicle"|"vehicle"|"suspectedHostile"|"hostile"|"tracking"|"engaging"|"retreating"|"disabled"|"destroyed"|"lost";
export interface MobileContact {id:string;estimate:Vec3;uncertainty:number;classification:MobileClassification;evidence:number;heading:number;speed:number;lastDetected:number;detectingUnitId:string|null;behavior:string;suspectedTargetId:string|null;damageState:string;}
export type DefenseAlert="normal"|"watch"|"alert"|"defensive"|"emergency"|"recovery";
export type RulesOfEngagement="evade"|"defensive"|"proactive";
export interface EchoRidgeSpec {station:Vec3;packagePos:Vec3;extraction:Vec3;fallbackPoints:Vec3[];droneSpawns:{id:string;role:DroneRole;pos:Vec3;heading:number}[];reinforcementSpawn:Vec3;}
export interface EchoRidgeState {phase:"approach"|"recovery"|"escort"|"complete"|"failed";alert:DefenseAlert;roe:RulesOfEngagement;protection:"carrier"|"damaged"|"atlas"|"fleet"|"auto";posture:"silent"|"balanced"|"aggressive";countermeasurePolicy:"conserve"|"threatened"|"maximum";withdrawalThreshold:number;formation:"screen"|"escort"|"spread"|"masking"|"retreat"|"auto";contacts:Map<string,MobileContact>;packageState:"station"|"carried"|"delivered"|"lost";carrierId:string|null;reinforcementIntroduced:boolean;revision:number;countermeasures:number;countermeasureCooldownUntil:number;interceptorsLaunched:number;startedAt:number;}
export type LinkState="linked"|"degraded"|"disconnected"|"reconnecting"|"synchronizing";
export type FallbackMode="hold"|"retrace"|"continueThenHold"|"rally";
export interface UnitLinkState {unitId:string;state:LinkState;quality:number;latency:number;route:string[];lastTransition:number;telemetryAt:number;lastKnownPos:Vec3;uncertainty:number;lastAck:string|null;fallback:FallbackMode;pendingState:LinkState|null;pendingSince:number;}
export type NetworkMessageState="queued"|"transmitting"|"relayed"|"delivered"|"delayed"|"failed"|"expired"|"superseded";
export interface NetworkMessage {id:string;sender:string;receiver:string;createdAt:number;deliverAt:number;priority:number;expiresAt:number;acknowledged:boolean;assignmentVersion:number;controlSession:number|null;state:NetworkMessageState;route:string[];kind:"operator"|"assignment"|"manual"|"telemetry"|"ack";}
export interface RelayNode {id:string;pos:Vec3;range:number;energy:number;active:boolean;deployedBy:string;}
export type NetworkPolicy="full"|"degraded"|"planned"|"auto";
export type CommunicationPosture="burst"|"balanced"|"continuous";
export interface FleetNetworkState {policy:NetworkPolicy;posture:CommunicationPosture;links:Map<string,UnitLinkState>;messages:NetworkMessage[];relays:RelayNode[];topologyRevision:number;jammerActive:boolean;jammerDetected:boolean;jammerPos:Vec3;}
export interface SilentDivideSpec {station:Vec3;blackBoxPos:Vec3;extraction:Vec3;relaySites:Vec3[];jammerPos:Vec3;deadZoneCenter:Vec3;deadZoneRadius:number;routes:{id:"reliable"|"divide";name:string;points:Vec3[]}[];}
export interface SilentDivideState {phase:"relays"|"recovery"|"extraction"|"complete";routeId:"reliable"|"divide";assignmentRevision:number;relayTargetIndex:number;unitRoutes:Map<string,{points:Vec3[];waypoint:number}>;}
export type CrownPhase="insertion"|"canyon"|"network"|"minefield"|"defense"|"core"|"extraction"|"complete"|"failed";
export interface AbyssalCrownSpec {checkpoints:Record<Exclude<CrownPhase,"complete"|"failed">,Vec3>;safeRoute:Vec3[];shortRoute:Vec3[];mineRoutes:{safe:Vec3[];short:Vec3[]};primaryExtraction:Vec3;alternateExtraction:Vec3;relaySite:Vec3;facility:Vec3;deadline:number;encounterAt:Record<string,number>;}
export interface CrownOptionalObjectives {samples:boolean;avoidEngagements:boolean;relayRecovered:boolean;probeRescued:boolean;allOperational:boolean;beforeDeadline:boolean;}
export interface CrownState {phase:CrownPhase;phaseEnteredAt:number;revision:number;canyonChoice:"safe"|"short";networkChoice:"relay"|"planned";mineChoice:"bypass"|"neutralize";defenseChoice:"evade"|"engage";extractionChoice:"primary"|"alternate";completed:Set<CrownPhase>;optional:CrownOptionalObjectives;recoveries:number;lastProgressAt:number;terminalReason:string;cinematicCue:string|null;}

export type FleetOrderKind =
  | "advance" // toward objective / point
  | "regroup"
  | "hold"
  | "repairs" // prioritize repairs
  | "investigate" // investigate a contact/point
  | "extract";

export interface FleetOrder {
  kind: FleetOrderKind;
  pos: Vec3 | null;
  targetId: string | null;
  issuedAt: number;
}

export type MissionPhase =
  | "deploy"
  | "survey" // survey canyon routes, locate facility
  | "approach" // deal with security + mines on the way in
  | "recovery" // MENDER recovering the core
  | "escort" // escort carrier to extraction
  | "won"
  | "lost";

export interface DecisionEntry {
  time: number;
  text: string;
}

export interface SimEvent {
  time: number;
  kind:
    | "contact"
    | "nodeAlert"
    | "nodeDisabled"
    | "mineHit"
    | "torpedoHit"
    | "unitDamaged"
    | "unitDisabled"
    | "unitDestroyed"
    | "repairDone"
    | "coreRecovered"
    | "coreDropped"
    | "objectiveDone"
    | "phaseChange"
    | "ping"
    | "jam"
    | "warning"
    | "stuck";
  text: string;
  pos: Vec3 | null;
  unitId: string | null;
}

export type GameSpeed = 0 | 1 | 2; // 0 = paused

export interface DifficultySpec {
  id: "easy" | "normal" | "hard";
  label: string;
  detectMul: number;
  damageMul: number;
  timeLimit: number; // seconds
  batteryDrainMul: number;
  nodeHp: number;
}

export const DIFFICULTIES: readonly DifficultySpec[] = [
  { id: "easy", label: "Calm Waters", detectMul: 0.8, damageMul: 0.7, timeLimit: 900, batteryDrainMul: 0.85, nodeHp: 2 },
  { id: "normal", label: "Standard Patrol", detectMul: 1.0, damageMul: 1.0, timeLimit: 780, batteryDrainMul: 1.0, nodeHp: 3 },
  { id: "hard", label: "Hostile Depths", detectMul: 1.15, damageMul: 1.2, timeLimit: 660, batteryDrainMul: 1.2, nodeHp: 4 }
] as const;
