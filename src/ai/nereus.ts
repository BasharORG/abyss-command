import { COMBAT, DETECTION, DOCTRINE, SIM, WORLD } from "../config";
import {
  DecisionEntry,
  Role,
  SimEvent,
  TaskKind,
  TrialDecision,
  TrialRouteAssessment,
  MinefieldCorridorAssessment,
  Unit,
  UnitTask,
  Vec3,
  dist3,
  distXZ,
  vec3
} from "../types";
import { Simulation } from "../sim/simulation";
import { spec } from "../sim/units";

interface TaskSpec {
  kind: TaskKind;
  pos: Vec3 | null;
  targetId: string | null;
  speedOrder: number;
  priority: number;
  desc: string;
  /** exclusive: only one unit may hold this task */
  exclusive: boolean;
  /** max assignees when not exclusive (Infinity = no limit) */
  maxAssignees: number;
  /** if set, only this unit may receive the task */
  onlyUnit?: string;
}

function key(t: { kind: TaskKind; targetId: string | null; pos: Vec3 | null }): string {
  const p = t.pos ? `${Math.round(t.pos.x / 60)},${Math.round(t.pos.z / 60)}` : "";
  return `${t.kind}|${t.targetId ?? ""}|${p}`;
}

/** role aptitude for a task kind, 0..1 */
function capability(role: Role, kind: TaskKind): number {
  switch (kind) {
    case "recover":
      return role === "MENDER" ? 1 : 0.35;
    case "fetchcore":
      return role === "MENDER" ? 1 : 0.5;
    case "survey":
    case "scout":
      return role === "GHOST" ? 1 : role === "ECHO" ? 0.85 : role === "LANCER" ? 0.4 : 0.3;
    case "investigate":
      return role === "GHOST" ? 1 : role === "ECHO" ? 0.85 : 0.4;
    case "attack":
      return role === "LANCER" ? 1 : 0;
    case "distract":
      return role === "ATLAS" ? 1 : role === "LANCER" ? 0.5 : role === "ECHO" ? 0.3 : 0.1;
    case "jam":
      return role === "ECHO" ? 1 : 0;
    case "escort":
      return role === "LANCER" ? 1 : role === "ECHO" ? 0.8 : role === "ATLAS" ? 0.7 : role === "GHOST" ? 0.5 : 0.2;
    case "repair":
    case "rescue":
      return role === "MENDER" ? 1 : 0;
    default:
      return 1;
  }
}

export type CommandEventKind =
  | "assigned" // new task committed to a unit
  | "reassigned" // task replaced by a different one
  | "completed" // task or order finished
  | "blocked" // route blocked / replan forced
  | "order"; // player fleet order received / cleared

export interface CommandEvent {
  time: number;
  kind: CommandEventKind;
  unitId: string | null;
  text: string;
  /** world position to focus when the entry is clicked */
  pos: Vec3 | null;
}

export class Nereus {
  private sim: Simulation;
  private planAt = 0;
  private replanNeeded = true;
  private replanReason = "mission start";
  readonly decisions: DecisionEntry[] = [];
  /** structured command feed for the live timeline — actual assignments only */
  readonly commandLog: CommandEvent[] = [];
  planSummary = "NEREUS: forming the fleet.";
  /** sim time of the most recent plan pass and what triggered it */
  lastPlanAt = -99;
  lastPlanReason = "mission start";
  trialDecision: TrialDecision | null = null;
  minefieldDecision: { revision:number; assessments:MinefieldCorridorAssessment[]; selectedCorridorId:"alpha"|"bravo"|null; explanation:string; units:TrialDecision["units"] } | null = null;
  private minefieldPlanKey="";
  private minefieldRevision=0;
  private trialPlanKey = "";
  private trialRevision = 0;
  private assignedScore = new Map<string, number>();
  private lastFire = new Map<string, number>();
  private followRefresh = new Map<string, number>();
  private orderVersion = 0;
  private lastOrderSeen: string | null = "none";

  constructor(sim: Simulation) {
    this.sim = sim;
  }

  private isCommandReachable(u: Unit): boolean {
    if (u.state !== "active" || u.control.mode !== "autonomous") return false;
    const link = this.sim.network.links.get(u.id);
    if (!link) return true;
    return ["linked", "degraded", "synchronizing"].includes(link.state) && this.sim.now - link.telemetryAt <= 15;
  }

  private route(from: Vec3, to: Vec3, danger?: (x: number, z: number) => number): Vec3[] | null {
    const riskMul = directiveRiskMultiplier(this.sim.directives.risk);
    const field = danger ? (x: number, z: number) => danger(x, z) * riskMul : undefined;
    return this.sim.nav.findPath(from, to, field, directiveDepthMeters(this.sim.directives.depth));
  }

  private emissionsAllowActive(): boolean {
    return this.sim.directives.emissions !== "passive";
  }

  onEvent(e: SimEvent) {
    switch (e.kind) {
      case "stuck":
        this.logCommand("blocked", e.unitId, `${e.unitId ? this.sim.unit(e.unitId)?.callsign : "Unit"}: route blocked — new route issued.`, e.pos);
        this.replanNeeded = true;
        this.replanReason = e.text;
        break;
      case "contact":
      case "unitDisabled":
      case "unitDestroyed":
      case "coreDropped":
      case "coreRecovered":
      case "objectiveDone":
      case "nodeAlert":
      case "nodeDisabled":
      case "mineHit":
        this.replanNeeded = true;
        this.replanReason = e.text;
        break;
      case "unitDamaged": {
        const u = e.unitId ? this.sim.unit(e.unitId) : null;
        if (u && u.hull < spec(u.role).hull * 0.5) {
          this.replanNeeded = true;
          this.replanReason = e.text;
        }
        break;
      }
      case "phaseChange":
        this.replanNeeded = true;
        this.replanReason = e.text;
        break;
      default:
        break;
    }
  }

  update() {
    const now = this.sim.now;
    if (this.sim.outcome) return;

    // order change detection
    const orderKey = this.sim.fleetOrder
      ? `${this.sim.fleetOrder.kind}|${this.sim.fleetOrder.issuedAt}`
      : "none";
    if (orderKey !== this.lastOrderSeen) {
      this.lastOrderSeen = orderKey;
      if (this.sim.fleetOrder) {
        this.orderVersion++;
        this.replanNeeded = true;
        this.replanReason = "new fleet order";
        const o = this.sim.fleetOrder;
        this.logCommand("order", null, `Player order received: ${o.kind}.`, o.pos ? { ...o.pos } : null);
      } else {
        this.logCommand("order", null, "Fleet order cleared — resuming mission plan.", null);
      }
    }

    if (this.replanNeeded || now >= this.planAt) {
      this.planAt = now + SIM.PLAN_INTERVAL;
      this.plan(this.replanReason);
      this.lastPlanAt = now;
      this.lastPlanReason = this.replanReason;
      this.replanNeeded = false;
      this.replanReason = "routine";
    }

    this.executeCombatTasks(now);
    this.refreshFollowTasks(now);
    this.adjustSpeedNearThreats();
    this.checkOrderCompletion();
  }

  /**
   * Quiet running near known threats: units transiting inside a detected
   * node's umbrella slow to silent speed (unless the doctrine is urgent or
   * the task requires noise, like attack/distraction).
   */
  private adjustSpeedNearThreats() {
    const sim = this.sim;
    const nodes = [...sim.contacts.values()]
      .filter((c) => c.kind === "securityNode")
      .map((c) => sim.nodes.find((n) => n.id === c.refId))
      .filter((n) => !!n && n.state !== "disabled" && n.state !== "destroyed");
    if (nodes.length === 0) return;
    for (const u of sim.units) {
      if (!this.isCommandReachable(u)) continue;
      if (u.task.kind === "attack" || u.task.kind === "distract") continue;
      const base = u.task.speedOrder ?? 1;
      const near = nodes.some((n) => distXZ(u.pos, n!.pos) < n!.detectRadius * 1.35);
      const quiet = near ? (sim.doctrine === "urgent" ? Math.min(base, 1) : 0) : base;
      if (quiet !== u.speedOrder) u.speedOrder = quiet;
    }
  }

  // ---------------------------------------------------------------- planning

  private plan(reason: string) {
    const sim = this.sim;
    const now = sim.now;
    const units = sim.units;
    const mobile = units.filter((u) => this.isCommandReachable(u));
    const doctrine = DOCTRINE[sim.doctrine];
    const changed: string[] = [];

    if (sim.canyonTrial && sim.mission.canyonTrial) {
      this.planCanyonTrial(reason);
      return;
    }
    if (sim.minefield && sim.mission.silentMinefield) {
      this.planSilentMinefield(reason);
      return;
    }
    if(sim.echoRidge&&sim.mission.echoRidge){this.planEchoRidge(reason);return;}
    if(sim.mission.silentDivide){this.planSilentDivide(reason);return;}
    if(sim.crown&&sim.mission.abyssalCrown){this.planAbyssalCrown(reason);return;}

    // --- candidate tasks -------------------------------------------------
    const tasks: TaskSpec[] = [];
    const order = sim.fleetOrder;
    const speedBase = doctrine.speedBias;
    const directiveSpeed=sim.directives.speed==="silent"?0:sim.directives.speed==="flank"?2:sim.directives.speed==="cruise"||sim.directives.speed==="slowest"?1:null;

    const push = (t: Partial<TaskSpec> & { kind: TaskKind; desc: string }) => {
      tasks.push({
        pos: null,
        targetId: null,
        speedOrder: speedBase,
        priority: 50,
        exclusive: true,
        maxAssignees: 1,
        ...t
      });
    };

    // Player orders dominate.
    if (order) {
      switch (order.kind) {
        case "hold":
          for (const u of mobile) {
            push({
              kind: "hold",
              pos: { ...u.pos },
              targetId: `hold-${u.id}`,
              priority: 88,
              speedOrder: 0,
              desc: `${u.callsign} holds position`,
              exclusive: false,
              onlyUnit: u.id
            });
          }
          break;
        case "regroup": {
          const target = order.targetId ? units.find((u) => u.id === order.targetId && u.state !== "destroyed") : undefined;
          const atlas = units.find((u) => u.role === "ATLAS" && u.state !== "destroyed");
          const anchor = target ? target.pos : atlas ? atlas.pos : centroid(mobile);
          const anchorName = target ? target.callsign : atlas ? "Atlas" : "the fleet";
          const radius = directiveFormationRadius(sim.directives.formation);
          let i = 0;
          for (const u of mobile) {
            const a = (i / Math.max(1, mobile.length)) * Math.PI * 2;
            push({
              kind: "regroup",
              pos: vec3(anchor.x + Math.cos(a) * radius, anchor.y, anchor.z + Math.sin(a) * radius),
              targetId: `regroup-${u.id}`,
              priority: 88,
              desc: `${u.callsign} regroups on ${anchorName}`,
              exclusive: false,
              onlyUnit: u.id
            });
            i++;
          }
          break;
        }
        case "investigate":
          if (order.pos) {
            push({
              kind: "investigate",
              pos: { ...order.pos },
              targetId: "order-investigate",
              priority: 92,
              desc: "investigating the marked contact"
            });
          }
          break;
        case "advance":
          if (order.pos) {
            push({
              kind: "scout",
              pos: { ...order.pos },
              targetId: "order-advance",
              priority: 90,
              desc: "scouting the advance objective"
            });
            let i = 0;
            for (const u of mobile) {
              const a = (i / Math.max(1, mobile.length)) * Math.PI * 2;
              push({
                kind: "regroup",
                pos: vec3(order.pos.x + Math.cos(a) * 140, order.pos.y, order.pos.z + Math.sin(a) * 140),
                targetId: `adv-${u.id}`,
                priority: 82,
                desc: `${u.callsign} advances on the marked position`,
                exclusive: false,
                onlyUnit: u.id
              });
              i++;
            }
          }
          break;
        case "repairs":
          // boosts repair candidates below
          break;
        case "extract":
          for (const u of mobile) {
            push({
              kind: "exfil",
              pos: { ...sim.mission.extractionPos },
              targetId: `exfil-${u.id}`,
              priority: 90,
              desc: `${u.callsign} proceeds to extraction`,
              exclusive: false,
              onlyUnit: u.id
            });
          }
          break;
      }
    }

    const phase = sim.phase;
    const timePressure = 1 - sim.timeRemaining / sim.difficulty.timeLimit;
    // a unit mid-interaction owns that interaction — don't double-assign it
    const recoveryInProgress = mobile.some(
      (u) => u.interactProgress > 0.05 && (u.task.kind === "recover" || u.task.kind === "fetchcore")
    );

    // Mission tasks (unless a hard order overrides movement).
    const hardOrder = order && (order.kind === "hold" || order.kind === "regroup" || order.kind === "advance" || order.kind === "extract");

    if (!hardOrder) {
      if (phase === "deploy" || phase === "survey") {
        const a = sim.objective("surveyA");
        const b = sim.objective("surveyB");
        if (!a.done) push({ kind: "survey", pos: a.pos, targetId: a.id, priority: 80, desc: "surveying the north canyon route" });
        if (!b.done) push({ kind: "survey", pos: b.pos, targetId: b.id, priority: 80, desc: "surveying the south canyon route" });
      }

      if (sim.coreState === "atFacility" && sim.facilityRevealed && (phase === "recovery" || phase === "approach") && !recoveryInProgress) {
        push({
          kind: "recover",
          pos: sim.mission.facilityPos,
          targetId: "facility",
          priority: 100 + timePressure * 15,
          speedOrder: Math.max(1, speedBase),
          desc: "recovering the data core"
        });
      }
      if (sim.coreState === "dropped" && sim.corePos && !recoveryInProgress) {
        push({
          kind: "fetchcore",
          pos: sim.corePos,
          targetId: "core",
          priority: 112,
          speedOrder: 1,
          desc: "retrieving the dropped data core"
        });
      }

      // threats known to the fleet
      const threats = [...sim.contacts.values()].filter((c) => c.kind === "securityNode");
      const lancer = units.find((u) => u.role === "LANCER");
      const lancerCanFight = !!lancer && lancer.state === "active" && lancer.torpedoes > 0;
      for (const c of threats) {
        const node = sim.nodes.find((n) => n.id === c.refId);
        if (!node || node.state === "disabled" || node.state === "destroyed") continue;
        const nearFacility = distXZ(c.pos, sim.mission.facilityPos) < 520;
        const nearExtraction = distXZ(c.pos, sim.mission.extractionPos) < 520;
        const carrier = sim.carrier();
        const nearCarrier = carrier ? distXZ(c.pos, carrier.pos) < 480 : false;
        if (!(nearFacility || nearExtraction || nearCarrier)) continue;
        if (lancerCanFight) {
          push({
            kind: "attack",
            pos: c.pos,
            targetId: node.id,
            priority: 72 + (nearCarrier ? 12 : 0) + (node.state === "alert" ? 8 : 0),
            speedOrder: 2,
            desc: "disabling a security node"
          });
        } else {
          // no attack option: jam it or distract it while others sneak by
          const echo = units.find((u) => u.role === "ECHO");
          if (echo && echo.state === "active") {
            push({
              kind: "jam",
              pos: c.pos,
              targetId: node.id,
              priority: 66,
              speedOrder: 1,
              desc: "jamming a security node"
            });
          } else if (nearFacility) {
            push({
              kind: "distract",
              pos: c.pos,
              targetId: node.id,
              priority: 60,
              speedOrder: 1,
              desc: "drawing a security node's attention"
            });
          }
        }
      }

      // escort & scouting around the carrier / recovery effort
        const carrier = sim.carrier();
      if (sim.coreState === "carried" && carrier) {
        push({
          kind: "exfil",
          pos: sim.mission.extractionPos,
          targetId: `exfil-${carrier.id}`,
          priority: 96 + timePressure * 20,
          speedOrder: Math.max(1, speedBase),
          desc: `${carrier.callsign} carries the core to extraction`,
          onlyUnit: carrier.id
        });
        push({
          kind: "escort",
          pos: null,
          targetId: carrier.id,
          priority: 78,
          exclusive: false,
          maxAssignees: sim.directives.cohesion === "together" ? 4 : 2,
          speedOrder: 1,
          desc: `escorting ${carrier.callsign}`
        });
        push({
          kind: "scout",
          pos: aheadOf(carrier.pos, sim.mission.extractionPos, 380),
          targetId: "scout-ahead",
          priority: 62,
          desc: "scouting the extraction route"
        });
        // everyone else heads to extraction too
        for (const u of mobile) {
          if (u.id === carrier.id) continue;
          push({
            kind: "exfil",
            pos: sim.mission.extractionPos,
            targetId: `exfil-${u.id}`,
            priority: sim.directives.cohesion === "independent" ? 74 : 58,
            speedOrder: speedBase,
            desc: `${u.callsign} proceeds to extraction`,
            exclusive: false,
            onlyUnit: u.id
          });
        }
      } else if (phase === "recovery" || phase === "approach") {
        // scout the facility approach while recovery is set up
        const mid = midpoint(centroid(mobile), sim.mission.facilityPos);
        push({ kind: "scout", pos: mid, targetId: "scout-facility", priority: 58, desc: "scouting the facility approach" });
        push({
          kind: "escort",
          pos: null,
          targetId: units.find((u) => u.role === "MENDER")?.id ?? null,
          priority: 60,
          exclusive: false,
          maxAssignees: 1,
          speedOrder: 1,
          desc: "covering Mender"
        });
      }
    }

    // repairs & support (always considered, even during orders)
    const mender = units.find((u) => u.role === "MENDER");
    const menderCanRepair = !!mender && mender.state === "active" && mender.repairKits > 0;
    if (menderCanRepair && order?.kind !== "hold") {
      const repairPriority = order?.kind === "repairs" ? 96 : 0;
      // a named repair target outranks the automatic triage
      const namedTarget = order?.kind === "repairs" && order.targetId ? units.find((u) => u.id === order.targetId && u.state !== "destroyed") : undefined;
      const candidates = namedTarget ? [namedTarget] : units.filter((u) => u.id !== mender!.id && u.state !== "destroyed");
      for (const u of candidates) {
        const full = spec(u.role).hull;
        if (u.state === "disabled") {
          push({
            kind: "repair",
            pos: { ...u.pos },
            targetId: u.id,
            priority: Math.max(95, repairPriority),
            speedOrder: 1,
            desc: `repairing ${u.callsign}`
          });
        } else if (u.hull < full * 0.55 || namedTarget) {
          push({
            kind: "repair",
            pos: { ...u.pos },
            targetId: u.id,
            priority: Math.max(74, repairPriority),
            speedOrder: 1,
            desc: `repairing ${u.callsign}`
          });
        }
      }
    }

    // resource conservation / withdrawal
    for (const u of mobile) {
      const isCarrier = u.hasCore;
      if (isCarrier) continue;
      if (u.battery < doctrine.batteryReserve) {
        push({
          kind: "exfil",
          pos: { ...sim.mission.extractionPos },
          targetId: `withdraw-${u.id}`,
          priority: 84,
          speedOrder: 0,
          desc: `${u.callsign} withdraws to conserve battery`,
          exclusive: false,
          onlyUnit: u.id
        });
      } else if (u.hull < spec(u.role).hull * 0.28 && !menderCanRepair) {
        push({
          kind: "exfil",
          pos: { ...sim.mission.extractionPos },
          targetId: `withdraw-${u.id}`,
          priority: 80,
          speedOrder: 0,
          desc: `${u.callsign} limps toward extraction`,
          exclusive: false,
          onlyUnit: u.id
        });
      }
      const reserve=Math.max(doctrine.batteryReserve,sim.logisticsPolicy.minimumReserve);
      if(u.battery<reserve&&sim.logisticsPolicy.conservation!=="spend"&&!u.hasCore){push({kind:"exfil",pos:{...sim.mission.extractionPos},targetId:`logistics-withdraw-${u.id}`,priority:88,speedOrder:0,desc:`${u.callsign} withdraws to preserve emergency reserve`,exclusive:false,onlyUnit:u.id});}
    }

    // --- scoring -----------------------------------------------------------
    interface Scored {
      unit: Unit;
      task: TaskSpec;
      score: number;
    }
    const scored: Scored[] = [];
    for (const u of mobile) {
      if (u.interactProgress > 0.05) continue; // mid-interaction: don't disturb
      for (const t of tasks) {
        if (t.onlyUnit && t.onlyUnit !== u.id) continue;
        // don't assign a unit to escort/repair itself
        if ((t.kind === "escort" || t.kind === "repair") && t.targetId === u.id) continue;
        const cap = capability(u.role, t.kind);
        if (cap <= 0) continue;
        if (u.hasCore && (t.kind === "attack" || t.kind === "distract" || t.kind === "scout")) continue;
        let s = t.priority * cap;
        const goal = taskGoal(t, sim);
        if (goal) {
          const travel = distXZ(u.pos, goal) / spec(u.role).cruiseSpeed;
          s -= travel * 0.15;
          s -= sim.knownThreatsNear(goal, 320).length * 7 * doctrine.dangerAversion;
        }
        if (u.battery < doctrine.batteryReserve + 12 && t.kind !== "exfil") s -= 26;
        if (u.hull < spec(u.role).hull * 0.4 && (t.kind === "attack" || t.kind === "distract" || t.kind === "scout")) s -= 28;
        // stickiness: prefer current task
        if (key(u.task) === key({ kind: t.kind, targetId: t.targetId, pos: t.pos })) s += 8;
        scored.push({ unit: u, task: t, score: s });
      }
    }
    scored.sort((a, b) => b.score - a.score);

    // --- greedy assignment with reservations ------------------------------
    const assignment = new Map<string, { task: TaskSpec; score: number }>();
    const taskCount = new Map<string, number>();
    const reservations = new Map<string, string>();
    for (const s of scored) {
      if (assignment.has(s.unit.id)) continue;
      const tkey = key(s.task);
      const count = taskCount.get(tkey) ?? 0;
      if (s.task.exclusive && count >= 1) continue;
      if (!s.task.exclusive && count >= s.task.maxAssignees) continue;
      assignment.set(s.unit.id, { task: s.task, score: s.score });
      taskCount.set(tkey, count + 1);
      if (s.task.targetId) reservations.set(s.task.targetId, s.unit.id);
    }

    // phase-appropriate defaults for the unassigned
    for (const u of mobile) {
      if (assignment.has(u.id)) continue;
      if (u.interactProgress > 0.05) continue;
      let def: TaskSpec;
      if (sim.coreState === "carried") {
        def = {
          kind: "exfil",
          pos: { ...sim.mission.extractionPos },
          targetId: `exfil-${u.id}`,
          speedOrder: speedBase,
          priority: 50,
          desc: `${u.callsign} proceeds to extraction`,
          exclusive: false,
          maxAssignees: Infinity
        };
      } else if (phase === "recovery" || phase === "approach") {
        // overwatch: hold between fleet and facility
        const anchor = midpoint(centroid(mobile), sim.mission.facilityPos);
        def = {
          kind: "hold",
          pos: anchor,
          targetId: `overwatch-${u.id}`,
          speedOrder: 0,
          priority: 40,
          desc: `${u.callsign} holds overwatch`,
          exclusive: false,
          maxAssignees: Infinity
        };
      } else {
        // survey phase: stage with the fleet
        const staging = centroid(mobile);
        def = {
          kind: "regroup",
          pos: staging,
          targetId: `stage-${u.id}`,
          speedOrder: speedBase,
          priority: 40,
          desc: `${u.callsign} stages with the fleet`,
          exclusive: false,
          maxAssignees: Infinity
        };
      }
      assignment.set(u.id, { task: def, score: def.priority });
    }

    // --- apply with commitment & hysteresis --------------------------------
    for (const u of mobile) {
      const next = assignment.get(u.id);
      if (!next) continue;
      const curKey = key(u.task);
      const nextKey = key(next.task);
      if (curKey === nextKey) {
        this.assignedScore.set(u.id, next.score);
        continue;
      }
      const curScore = this.assignedScore.get(u.id) ?? 0;
      const committed = now < u.task.commitUntil;
      const curTaskValid = this.taskStillValid(u.task);
      // soft update: same kind of task whose goal merely drifted (moving
      // centroid/anchor) — refresh the path quietly without logging or
      // resetting the commitment timer
      const nextGoal = taskGoal(next.task, sim);
      if (
        curTaskValid &&
        u.task.kind === next.task.kind &&
        nextGoal &&
        u.task.pos &&
        distXZ(u.task.pos, nextGoal) < 150
      ) {
        u.task.pos = { ...nextGoal };
        const p = this.route(u.pos, nextGoal, (x, z) => sim.dangerAt(x, z));
        if (p) {
          u.task.path = p;
          u.task.pathIndex = 0;
        }
        u.task.desc = next.task.desc;
        this.assignedScore.set(u.id, next.score);
        continue;
      }
      const forced =
        !curTaskValid ||
        u.task.kind === "idle" ||
        reason === "new fleet order" ||
        next.task.priority >= 95;
      if (committed && curTaskValid && !forced && next.score < curScore * SIM.HYSTERESIS) {
        continue; // keep current task (hysteresis)
      }
      if (sim.network.links.get(u.id)?.state === "disconnected") continue;
      const wasKind = u.task.kind;
      // commit: build path
      const goal = taskGoal(next.task, sim);
      let path: Vec3[] = [];
      if (goal && next.task.kind !== "hold") {
        const p = this.route(u.pos, goal, (x, z) => sim.dangerAt(x, z));
        path = p ?? [];
      } else if (next.task.kind === "hold" && next.task.pos) {
        if (distXZ(u.pos, next.task.pos) > 30) {
          const p = this.route(u.pos, next.task.pos, (x, z) => sim.dangerAt(x, z));
          path = p ?? [];
        }
      }
      u.task = {
        kind: next.task.kind,
        pos: next.task.pos ? { ...next.task.pos } : null,
        targetId: next.task.targetId,
        committedAt: now,
        commitUntil: now + SIM.COMMIT_TIME,
        path,
        pathIndex: 0,
        desc: next.task.desc
      };
      // hurry up as the storm approaches (but never below task minimum)
      const boosted = Math.min(2, next.task.speedOrder + (timePressure > 0.55 ? 1 : 0));
      u.speedOrder = boosted;
      if(directiveSpeed!==null)u.speedOrder=directiveSpeed;
      u.task.speedOrder = boosted;
      this.assignedScore.set(u.id, next.score);
      changed.push(`${u.callsign} → ${next.task.desc}`);
      // structured timeline entry for the actual assignment
      const trigger = reason !== "routine" ? ` (${reason})` : "";
      const wasMeaningful = wasKind !== "idle" && wasKind !== next.task.kind;
      this.logCommand(
        wasMeaningful ? "reassigned" : "assigned",
        u.id,
        `${u.callsign} ${wasMeaningful ? "reassigned" : "assigned"}: ${next.task.desc}${trigger}.`,
        goal ? { ...goal } : null
      );
    }

    if (changed.length > 0) {
      const why = reason !== "routine" ? ` (${reason})` : "";
      this.log(`Replan${why}: ${changed.join("; ")}.`);
    }

    // --- concise factual plan summary --------------------------------------
    const parts = mobile.map((u) => {
      const a = assignment.get(u.id);
      return a ? `${u.callsign}: ${a.task.desc.replace(`${u.callsign} `, "")}` : `${u.callsign}: standing by`;
    });
    const threats = sim.knownThreatsNear(sim.carrier()?.pos ?? centroid(mobile), 600).length;
    this.planSummary =
      `Objective: ${sim.objectiveText()}  ·  ` +
      parts.join(" · ") +
      (threats > 0 ? `  ·  Known threats nearby: ${threats}` : "");
  }

  private planCanyonTrial(reason: string) {
    const sim = this.sim;
    const trial = sim.canyonTrial!;
    const course = sim.mission.canyonTrial!;
    const active = sim.units.filter((u) => this.isCommandReachable(u) && !trial.completedUnitIds.has(u.id));
    const obstacleKnown = course.barrier.some((o) => o.discovered);

    if (!obstacleKnown) {
      for (let i = 0; i < active.length; i++) {
        const u = active[i];
        const slot = course.stagingSlots[i];
        this.commitTrialTask(u, "transit", slot, [slot], "scanning Canyon Passage", "scan", 0, Math.min(5, trial.speedLimit));
      }
      this.trialDecision = {
        revision: this.trialRevision,
        assessments: course.corridors.map((c) => ({
          corridorId: c.id,
          distance: pathLength(c.points),
          status: "unverified",
          usableBy: [],
          requiredClearance: {},
          reason: "Awaiting obstacle observations from fleet sensors."
        })),
        units: active.map((u) => ({ unitId: u.id, corridorId: "outer", sequence: null, state: "scanning", waitingFor: null, progress: 0 })),
        explanation: "Fleet is approaching the scan line. Candidate passages remain unverified until the barrier is detected.",
        decidedAt: sim.now,
        transitioning: true
      };
      this.planSummary = "Canyon Passage: fleet advancing to the obstacle scan line.";
      return;
    }

    const assessments: TrialRouteAssessment[] = course.corridors.map((corridor) => {
      const usableBy = sim.units.filter((u) => requiredHalfWidth(u, trial.clearanceMargin) <= corridor.width / 2).map((u) => u.role);
      const blockedByRockfall = corridor.id === "narrow" && course.rockfall.active && course.rockfall.discovered;
      return {
        corridorId: corridor.id,
        distance: pathLength(corridor.points),
        status: blockedByRockfall ? "blocked" : "available",
        usableBy: blockedByRockfall ? [] : usableBy,
        requiredClearance: Object.fromEntries(sim.units.map((u) => [u.role, requiredHalfWidth(u, trial.clearanceMargin)])),
        reason: blockedByRockfall
          ? "Rockfall intersects the passage."
          : `${usableBy.length}/5 hulls meet the ${trial.clearanceMargin.toFixed(1)} m additional-clearance rule.`
      };
    });
    const narrow = assessments.find((a) => a.corridorId === "narrow")!;
    const allFitNarrow = narrow.status === "available" && narrow.usableBy.length === sim.units.length;
    const split = trial.coordination === "split" && trial.priority === "fastest" && narrow.status === "available" && narrow.usableBy.length > 0;
    const signature = `${trial.priority}|${trial.coordination}|${trial.clearanceMargin}|${trial.speedLimit}|${trial.held}|${course.rockfall.active && course.rockfall.discovered}|${allFitNarrow}|${split}`;
    if (signature !== this.trialPlanKey) {
      this.trialPlanKey = signature;
      this.trialRevision++;
      this.log(`Obstacle plan revision ${this.trialRevision}: ${reason}.`);
      const blocked = course.rockfall.active && course.rockfall.discovered;
      this.logCommand(blocked ? "blocked" : "order", null, blocked ? "Narrow Cut invalidated by the detected rockfall; replacement plan issued." : "Canyon Passage route plan issued.", blocked ? course.rockfall.pos : course.regroupPoint);
      if (narrow.usableBy.length < sim.units.length) {
        this.logCommand("blocked", null, `Narrow Cut rejected for ${sim.units.length - narrow.usableBy.length} hulls: insufficient clearance at ${trial.clearanceMargin.toFixed(1)} m margin.`, course.corridors.find((c) => c.id === "narrow")!.points[2]);
      }
    }

    const narrowUnits = split ? active.filter((u) => narrow.usableBy.includes(u.role)) : [];
    const narrowPending = narrowUnits.filter((u) => !trial.completedUnitIds.has(u.id));
    const releasedNarrow = narrowPending[0]?.id ?? null;
    const unitPlans: TrialDecision["units"] = [];
    for (let i = 0; i < active.length; i++) {
      const u = active[i];
      const useNarrow = split && narrow.usableBy.includes(u.role);
      const corridorId = useNarrow ? "narrow" : allFitNarrow && trial.priority === "fastest" ? "narrow" : "outer";
      const corridor = course.corridors.find((c) => c.id === corridorId)!;
      const sequence = useNarrow ? narrowUnits.findIndex((x) => x.id === u.id) + 1 : null;
      const waiting = useNarrow && u.id !== releasedNarrow;
      if (trial.held || waiting) {
        const slot = trial.held ? { ...u.pos } : course.stagingSlots[i];
        this.commitTrialTask(u, "hold", slot, distXZ(u.pos, slot) > 25 ? [slot] : [], trial.held ? "holding by player constraint" : `waiting for Narrow Cut reservation ${sequence}`, corridorId, this.trialRevision, 0);
      } else {
        const laneIndex = sim.units.findIndex((fleetUnit) => fleetUnit.id === u.id);
        const laneOffset = corridorId === "outer" ? [-28, -14, 0, 14, 28][laneIndex] : 0;
        const route = offsetCorridor(corridor.points, laneOffset);
        // Followers commit progressively; the existing movement controller
        // then enters the shared turn instead of pivoting all hulls at once.
        const assignedAt = u.task.routeRevision === this.trialRevision ? u.task.committedAt : sim.now;
        const transitionDelay = Math.max(0, laneIndex * 1.1 - (sim.now - assignedAt));
        this.commitTrialTask(u, "transit", course.regroupPoint, route, corridorId === "narrow" ? `entering Narrow Cut · sequence ${sequence}` : "following Outer Passage", corridorId, this.trialRevision, trial.speedLimit);
        if (transitionDelay > 0) u.task.speedLimit = Math.min(u.task.speedLimit ?? trial.speedLimit, 2.5);
      }
      const goalDist = Math.max(1, distXZ(sim.mission.deployment[i], course.regroupPoint));
      unitPlans.push({
        unitId: u.id,
        corridorId,
        sequence,
        state: trial.held || waiting ? "waiting" : corridorId === "narrow" ? "entering" : "outer",
        waitingFor: waiting ? releasedNarrow : trial.held ? "Resume navigation" : null,
        progress: Math.max(0, Math.min(1, 1 - distXZ(u.pos, course.regroupPoint) / goalDist))
      });
    }
    for (const u of sim.units.filter((x) => trial.completedUnitIds.has(x.id))) {
      unitPlans.push({ unitId: u.id, corridorId: u.task.corridorId === "narrow" ? "narrow" : "outer", sequence: null, state: trial.status === "complete" ? "complete" : "regrouping", waitingFor: null, progress: 1 });
    }
    const explanation = trial.held
      ? "Fleet movement is held. Existing safe positions are maintained until navigation resumes."
      : split
        ? `${narrow.usableBy.length} compatible vessels use Narrow Cut sequentially; remaining vessels use Outer Passage. All regroup at the exit.`
        : allFitNarrow && trial.priority === "fastest"
          ? "All five submarines meet Narrow Cut clearance. Fleet cohesion is preserved through the shorter passage."
          : `Fleet cohesion is enabled or Narrow Cut cannot carry every hull. All five submarines use Outer Passage with ${trial.clearanceMargin.toFixed(1)} m additional clearance.`;
    this.trialDecision = { revision: this.trialRevision, assessments, units: unitPlans, explanation, decidedAt: sim.now, transitioning: false };
    this.planSummary = explanation;
  }

  private commitTrialTask(u: Unit, kind: "transit" | "hold", pos: Vec3, path: Vec3[], desc: string, corridorId: string, revision: number, speedLimit: number) {
    if (this.sim.network.links.get(u.id)?.state === "disconnected") return;
    const same = u.task.kind === kind && u.task.corridorId === corridorId && u.task.routeRevision === revision && u.task.desc === desc;
    if (same) {
      u.task.speedLimit = speedLimit;
      return;
    }
    u.task = {
      kind,
      pos: { ...pos },
      targetId: corridorId,
      committedAt: this.sim.now,
      commitUntil: this.sim.now + SIM.COMMIT_TIME,
      path,
      pathIndex: 0,
      desc,
      speedOrder: speedLimit <= spec(u.role).silentSpeed ? 0 : 1,
      speedLimit,
      corridorId,
      routeRevision: revision
    };
    u.speedOrder = u.task.speedOrder ?? 1;
    this.logCommand("assigned", u.id, `${u.callsign}: ${desc}.`, pos);
  }

  private planSilentMinefield(reason:string){
    const sim=this.sim,state=sim.minefield!,course=sim.mission.silentMinefield!;
    const known=[...state.contacts.values()];
    const assessments:MinefieldCorridorAssessment[]=course.corridors.map(c=>{
      const affecting=known.filter(k=>k.corridorId===c.id&&!["decoy","disabled","lost"].includes(k.classification));
      const confirmed=affecting.filter(k=>k.classification==="mine"); const unresolved=affecting.filter(k=>["unknown","possibleHazard","probableMine","lost"].includes(k.classification));
      const blocked=state.policy==="avoid"&&confirmed.length>0;
      const status=!state.scanStarted?"unverified":unresolved.length?"scanning":blocked?"blocked":confirmed.length?"degraded":"valid";
      return {corridorId:c.id,name:c.name,distance:pathLength(c.points),status,affectingContacts:affecting.map(x=>x.id),transitTime:pathLength(c.points)/8,reason:!state.scanStarted?"Awaiting reconnaissance.":unresolved.length?`${unresolved.length} unresolved returns require classification.`:blocked?`${confirmed.length} confirmed mines violate avoidance policy.`:confirmed.length?`${confirmed.length} confirmed blocking threats require bypass or authorization.`:"No known actionable threat intersects the corridor."};
    });
    const alpha=assessments.find(a=>a.corridorId==="alpha")!,bravo=assessments.find(a=>a.corridorId==="bravo")!;
    let selected:"alpha"|"bravo"|null=null;
    if(state.crossingStarted&&!state.held&&!state.retreat){
      const candidates=assessments.filter(a=>a.status==="valid"||(state.policy!=="avoid"&&a.status==="degraded"));
      selected=(state.policy==="shortest"?candidates.sort((a,b)=>a.distance-b.distance)[0]:candidates.sort((a,b)=>a.affectingContacts.length-b.affectingContacts.length||a.distance-b.distance)[0])?.corridorId??null;
    }
    const signature=`${state.status}|${state.posture}|${state.policy}|${state.formation}|${state.clearance}|${state.held}|${state.retreat}|${state.neutralizationAuthorized}|${selected}|${known.map(c=>`${c.id}:${c.classification}:${c.disabled}`).join("|")}`;
    if(signature!==this.minefieldPlanKey){this.minefieldPlanKey=signature;this.minefieldRevision++;state.replans++;this.log(`Minefield plan revision ${this.minefieldRevision}: ${reason}.`);}
    const units:TrialDecision["units"]=[];
    const echo=sim.units.find(u=>u.role==="ECHO")!,ghost=sim.units.find(u=>u.role==="GHOST")!,lancer=sim.units.find(u=>u.role==="LANCER")!;
    const blockingMine=known.find(c=>c.classification==="mine"&&c.corridorId==="alpha"&&!c.disabled);
    for(let i=0;i<sim.units.length;i++){
      const u=sim.units[i]; let desc="guarding fleet",kind:"transit"|"hold"="hold",path:Vec3[]=[],corridorId:"alpha"|"bravo"="bravo",st="guarding";
      if(state.retreat){desc="emergency retreat";kind="transit";path=[{...sim.mission.deployment[i]}];st="retreating";}
      else if(!state.scanStarted){desc="holding scan perimeter";}
      else if(state.neutralizationAuthorized&&blockingMine&&u.id===lancer.id){
        desc=`neutralizing ${blockingMine.id}`;kind="transit";const stand={x:blockingMine.estimate.x-150,y:blockingMine.estimate.y,z:blockingMine.estimate.z};path=[stand];st="guarding";
        if(distXZ(u.pos,stand)<35) sim.neutralizeMine(blockingMine.id);
      }
      else if(!selected){
        if(u.id===echo.id){desc="scanning minefield sectors";kind="transit";path=[{...course.stagingSlots[0]}];st="scanning";if(state.posture!=="passive"&&this.emissionsAllowActive()&&sim.now>=u.sonarActiveUntil)sim.ping(u.id);}
        else if(u.id===ghost.id){const target=known.find(c=>!["mine","decoy","disabled"].includes(c.classification));desc=target?`investigating ${target.id}`:"quiet reconnaissance";kind="transit";path=[target?{...target.estimate}:{...course.stagingSlots[1]}];st="investigating";}
        else desc=u.id===lancer.id?"guarding reconnaissance":"waiting for corridor certification";
      } else {
        const corridor=course.corridors.find(c=>c.id===selected)!;corridorId=selected;
        const seq=i+1;const predecessor=i>0?sim.units[i-1]:null;
        const predecessorCleared=!!predecessor&&(state.completedUnitIds.has(predecessor.id)||distXZ(predecessor.pos,sim.mission.deployment[i-1])>430);
        const released=state.formation==="paired"?i<2||predecessorCleared:state.formation==="auto"?true:i===0||predecessorCleared;
        if(released){desc=`crossing ${corridor.name}`;kind="transit";const full=offsetCorridor(corridor.points,state.formation==="paired"?(i%2?16:-16):0);let current=0;if(u.task.corridorId===corridorId){let best=Infinity;for(let k=0;k<full.length;k++){const d=distXZ(u.pos,full[k]);if(d<best){best=d;current=k;}}if(current<full.length-1&&distXZ(u.pos,full[current+1])<distXZ(u.pos,full[current]))current++;}path=full.slice(current);st="entering";}else desc=`waiting ${seq}`;
      }
      this.commitTrialTask(u,kind,kind==="transit"?(path[path.length-1]??u.pos):course.stagingSlots[i],path,desc,corridorId,this.minefieldRevision,7);
      units.push({unitId:u.id,corridorId:corridorId==="alpha"?"narrow":"outer",sequence:i+1,state:st==="scanning"?"scanning":st==="entering"?"entering":st==="retreating"?"replanning":"waiting",waitingFor:kind==="hold"?"Corridor clearance":null,progress:selected?Math.max(0,Math.min(1,1-distXZ(u.pos,course.regroupPoint)/1900)):0});
    }
    const explanation=state.retreat?"Emergency retreat active. Fleet is returning along stored safe approaches.":!state.scanStarted?"Fleet is holding outside the field. Begin scan to build the shared tactical picture.":!selected?`Reconnaissance active: ${known.length} contacts tracked. NEREUS is withholding crossing approval until a corridor is certified.`:`${selected==="alpha"?alpha.name:bravo.name} selected under ${state.policy} policy. ${state.formation} formation reservations are active.`;
    this.minefieldDecision={revision:this.minefieldRevision,assessments,selectedCorridorId:selected,explanation,units};this.planSummary=explanation;
  }

  private planEchoRidge(reason:string){const sim=this.sim,state=sim.echoRidge!,ridge=sim.mission.echoRidge!,autonomous=sim.units.filter(u=>this.isCommandReachable(u));const known=[...state.contacts.values()],hostile=known.filter(c=>["hostile","engaging","tracking","suspectedHostile"].includes(c.classification));const living=sim.units.filter(u=>u.state!=="destroyed");const protectedUnit=state.protection==="atlas"?living.find(u=>u.role==="ATLAS")!:state.carrierId?sim.unit(state.carrierId)!:living.reduce((a,b)=>a.hull<b.hull?a:b);const lancer=autonomous.find(u=>u.role==="LANCER"),echo=autonomous.find(u=>u.role==="ECHO"),ghost=autonomous.find(u=>u.role==="GHOST"),mender=autonomous.find(u=>u.role==="MENDER");const recoverer=mender??autonomous.find(u=>u.logistics.objectiveCapacity>0);const primary=hostile[0];
    for(const u of autonomous){let goal=ridge.station,desc="approaching Echo Ridge";if(state.packageState==="delivered"){goal=ridge.extraction;desc=u.id===state.carrierId?"holding package at extraction":`regrouping at extraction around ${protectedUnit.callsign}`;}else if(state.packageState==="station"&&u.id===recoverer?.id){goal=ridge.packagePos;desc="recovering sensor package";}else if(primary&&u.id===lancer?.id){goal=midpoint(primary.estimate,protectedUnit.pos);desc=`screening ${protectedUnit.callsign}`;}else if(primary&&u.id===ghost?.id){goal={x:primary.estimate.x-180,y:primary.estimate.y,z:primary.estimate.z+120};desc=`tracking ${primary.id}`;}else if(primary&&u.id===echo?.id){goal={...protectedUnit.pos};desc="maintaining hostile track";}else if(state.packageState==="carried"){goal=ridge.extraction;desc=u.id===state.carrierId?"carrying package to extraction":`escorting ${protectedUnit.callsign}`;}const path=sim.nav.findPath(u.pos,goal,(x,z)=>sim.dangerAt(x,z))??[goal];this.commitTrialTask(u,"transit",goal,path,desc,"defense",state.revision, state.posture==="silent"?spec(u.role).silentSpeed:state.posture==="aggressive"?spec(u.role).maxSpeed:spec(u.role).cruiseSpeed);}
    if(primary&&lancer&&state.roe!=="evade"&&primary.classification==="hostile"&&distXZ(lancer.pos,primary.estimate)<520)sim.launchDefensiveInterceptor(primary.id);
    if(state.alert==="defensive"&&echo&&state.countermeasurePolicy!=="conserve"&&state.countermeasures>0)sim.deployCountermeasure(echo.id);
    const explanation=primary?`${primary.id} is the primary threat. ${lancer?.callsign??"No interceptor"} screens ${protectedUnit.callsign}; Echo maintains track and Ghost shadows the contact.`:`Fleet is approaching Echo Ridge under ${state.alert.toUpperCase()} alert while Echo searches for mobile contacts.`;this.planSummary=explanation;this.log(`Defense plan R${state.revision}: ${reason}.`);}

  private planSilentDivide(reason:string){
    const sim=this.sim,divide=sim.mission.silentDivide!,state=sim.silentDivideState!,autonomous=sim.units.filter(u=>this.isCommandReachable(u));
    const route=divide.routes.find(r=>r.id===state.routeId)!;
    const echo=autonomous.find(u=>u.role==="ECHO");
    const requiredRelays=sim.network.policy==="full"?divide.relaySites.length:sim.network.policy==="planned"?0:2;
    const activeRelays=sim.network.relays.filter(r=>r.active).length;
    if(state.phase==="relays"&&activeRelays<requiredRelays&&echo){
      const site=divide.relaySites[state.relayTargetIndex];
      if(distXZ(echo.pos,site)<80){sim.deployRelay(echo.id);state.relayTargetIndex++;state.assignmentRevision++;}
      for(const u of autonomous){
        if(u.id===echo.id){const path=sim.nav.findPath(u.pos,site)??[{...site}];u.task={kind:"transit",pos:{...site},targetId:`relay-${state.relayTargetIndex+1}`,committedAt:sim.now,commitUntil:sim.now+6,path,pathIndex:0,desc:`deploying communication relay ${state.relayTargetIndex+1}`,speedOrder:1,speedLimit:spec(u.role).cruiseSpeed,corridorId:"network-relay",routeRevision:state.assignmentRevision};u.speedOrder=1;}
        else{u.task={kind:"hold",pos:{...u.pos},targetId:"network-hold",committedAt:sim.now,commitUntil:sim.now+6,path:[],pathIndex:0,desc:"waiting for relay coverage",speedOrder:0,speedLimit:0,corridorId:"network-hold",routeRevision:state.assignmentRevision};u.speedOrder=0;}
      }
      this.planSummary=`Echo is deploying relay ${state.relayTargetIndex+1}/${requiredRelays}; fleet holding inside command coverage.`;return;
    }
    if(state.phase==="relays"){state.phase="recovery";state.assignmentRevision++;state.unitRoutes.clear();}
    if(sim.coreState==="carried"&&state.phase!=="extraction"){state.phase="extraction";state.assignmentRevision++;state.unitRoutes.clear();}
    for(const u of autonomous){
      let record=state.unitRoutes.get(u.id);
      if(!record){
        let points:Vec3[];
        if(state.phase==="extraction")points=[...route.points.map(p=>({...p})),{...divide.extraction}];
        else{const stationIndex=route.points.reduce((best,p,i)=>distXZ(p,divide.station)<distXZ(route.points[best],divide.station)?i:best,0);points=[...route.points.slice(0,stationIndex+1).map(p=>({...p})),{...divide.station}];}
        let nearest=0,best=Infinity;for(let i=0;i<points.length;i++){const d=distXZ(u.pos,points[i]);if(d<best){best=d;nearest=i;}}
        record={points:points.slice(nearest),waypoint:0};state.unitRoutes.set(u.id,record);
      }
      const goal=state.phase==="extraction"?divide.extraction:divide.blackBoxPos;
      const desc=state.phase==="extraction"?(u.id===sim.carrierId?"carrying black box to extraction":"escorting black box carrier"):(u.role==="MENDER"?"recovering Silent Divide black box":`following ${route.name}`);
      if(u.task.routeRevision!==state.assignmentRevision){u.task={kind:"transit",pos:{...goal},targetId:route.id,committedAt:sim.now,commitUntil:sim.now+6,path:record.points.map(p=>({...p})),pathIndex:record.waypoint,desc,speedOrder:1,speedLimit:sim.network.posture==="burst"?spec(u.role).silentSpeed:spec(u.role).cruiseSpeed,corridorId:route.id,routeRevision:state.assignmentRevision};u.speedOrder=1;}
      record.waypoint=u.task.pathIndex;
    }
    this.planSummary=`${route.name} active. ${activeRelays} relays online; phase ${state.phase}.`;if(reason!=="routine")this.log(`Network plan: ${reason}.`);
  }

  private planAbyssalCrown(reason:string){const sim=this.sim,state=sim.crown!,s=sim.mission.abyssalCrown!,units=sim.units.filter(u=>this.isCommandReachable(u));let route:Vec3[]=[s.checkpoints.insertion],desc="forming for mission insertion";if(state.phase==="canyon"){route=state.canyonChoice==="short"?s.shortRoute:s.safeRoute;desc=`crossing ${state.canyonChoice} canyon route`;}else if(state.phase==="network"){route=[s.checkpoints.canyon,s.relaySite,s.checkpoints.network];desc=state.networkChoice==="relay"?"restoring relay coverage":"executing acknowledged disconnect plan";}else if(state.phase==="minefield"){route=state.mineChoice==="neutralize"?s.mineRoutes.short:s.mineRoutes.safe;desc=`crossing ${state.mineChoice} minefield route`;}else if(state.phase==="defense"){route=[s.checkpoints.minefield,s.checkpoints.defense];desc=state.defenseChoice==="engage"?"screening against hostile contacts":"terrain-masked evasion";}else if(state.phase==="core"){route=[s.checkpoints.defense,s.facility];desc="recovering Abyssal Crown data core";}else if(state.phase==="extraction"){const ext=state.extractionChoice==="primary"?s.primaryExtraction:s.alternateExtraction;route=[s.facility,ext];desc=sim.carrierId?"escorting data-core carrier":"proceeding to extraction";}
    for(const u of units){let points=route.map(p=>({...p})),goal=points.at(-1)!;let nearest=0,best=Infinity;for(let i=0;i<points.length;i++){const d=distXZ(u.pos,points[i]);if(d<best){best=d;nearest=i;}}points=points.slice(nearest);const unitDesc=state.phase==="core"&&u.role==="MENDER"?"recovering Abyssal Crown data core":state.phase==="extraction"&&u.id===sim.carrierId?"carrying data core to extraction":desc;this.commitTrialTask(u,"transit",goal,points,unitDesc,"crown",state.revision,spec(u.role).cruiseSpeed);}
    if(state.phase==="network"&&state.networkChoice==="relay"&&!sim.network.relays.some(r=>r.active)){const echo=units.find(u=>u.role==="ECHO");if(echo&&distXZ(echo.pos,s.relaySite)<75)sim.deployRelay(echo.id);}this.planSummary=`Abyssal Crown ${state.phase}: ${desc}.`;if(reason!=="routine")this.log(`Crown plan R${state.revision}: ${reason}.`);}

  private taskStillValid(t: UnitTask): boolean {
    const sim = this.sim;
    switch (t.kind) {
      case "survey": {
        const o = sim.objectives.find((x) => x.id === t.targetId);
        return !!o && !o.done;
      }
      case "recover":
        return sim.coreState === "atFacility";
      case "fetchcore":
        return sim.coreState === "dropped";
      case "attack":
      case "distract":
      case "jam": {
        const node = sim.nodes.find((n) => n.id === t.targetId);
        return !!node && node.state !== "disabled" && node.state !== "destroyed";
      }
      case "repair":
      case "rescue": {
        const target = t.targetId ? sim.unit(t.targetId) : null;
        if (!target || target.state === "destroyed") return false;
        return target.state === "disabled" || target.hull < spec(target.role).hull * 0.8;
      }
      case "escort": {
        const target = t.targetId ? sim.unit(t.targetId) : null;
        return !!target && target.state !== "destroyed";
      }
      default:
        return true;
    }
  }

  // -------------------------------------------------------------- execution

  /** Attack / distract / jam behavior, evaluated continuously. */
  private executeCombatTasks(now: number) {
    const sim = this.sim;
    for (const u of sim.units) {
      if (!this.isCommandReachable(u)) continue;
      const t = u.task;
      if (t.kind !== "attack" && t.kind !== "distract" && t.kind !== "jam") continue;
      const node = sim.nodes.find((n) => n.id === t.targetId);
      if (!node || node.state === "disabled" || node.state === "destroyed") continue;
      const d = dist3(u.pos, node.pos);

      if (t.kind === "attack") {
        const losClear = !sim.mission.terrain.losBlocked(u.pos, node.pos);
        // fire when in range with LOS
        if (d < COMBAT.TORPEDO_RANGE && losClear) {
          const last = this.lastFire.get(u.id) ?? -10;
          if (now - last > 3.5) {
            if (sim.fireTorpedo(u, node.id)) this.lastFire.set(u.id, now);
          }
        }
        // arrived at (or near) the end of the assigned path?
        const lastWp = u.task.path.length > 0 ? u.task.path[u.task.path.length - 1] : null;
        const stationary = u.task.path.length === 0 || (lastWp ? distXZ(u.pos, lastWp) < 30 : true);
        if (stationary) {
          if (d < COMBAT.ATTACK_STANDOFF * 0.6) {
            // too close: back off to standoff
            const away = vec3(u.pos.x - node.pos.x, 0, u.pos.z - node.pos.z);
            const m = Math.hypot(away.x, away.z) || 1;
            const goal = vec3(
              node.pos.x + (away.x / m) * COMBAT.ATTACK_STANDOFF,
              u.pos.y,
              node.pos.z + (away.z / m) * COMBAT.ATTACK_STANDOFF
            );
            const p = sim.nav.findPath(u.pos, goal, (x, z) => sim.dangerAt(x, z));
            if (p) {
              u.task.path = p;
              u.task.pathIndex = 0;
            }
          } else if (d < COMBAT.TORPEDO_RANGE * 0.95 && !losClear) {
            // in range but terrain blocks the shot: hunt for a firing position
            for (let k = 0; k < 8; k++) {
              const a = (k / 8) * Math.PI * 2;
              const goal = vec3(
                node.pos.x + Math.cos(a) * COMBAT.ATTACK_STANDOFF,
                u.pos.y,
                node.pos.z + Math.sin(a) * COMBAT.ATTACK_STANDOFF
              );
              if (sim.mission.terrain.losBlocked(goal, node.pos)) continue;
              const p = sim.nav.findPath(u.pos, goal, (x, z) => sim.dangerAt(x, z));
              if (p) {
                u.task.path = p;
                u.task.pathIndex = 0;
                this.log(`Replan: Lancer repositions for a clear shot.`);
                break;
              }
            }
          } else if (d >= COMBAT.TORPEDO_RANGE * 0.95) {
            // drifted out of range: close back to standoff
            const goal = taskGoal(t, sim);
            if (goal) {
              const p = sim.nav.findPath(u.pos, goal, (x, z) => sim.dangerAt(x, z));
              if (p) {
                u.task.path = p;
                u.task.pathIndex = 0;
              }
            }
          }
        }
      } else if (t.kind === "distract") {
        // loiter loudly at the edge of the node's umbrella and ping
        if (d < node.detectRadius * 0.85) {
          u.task.path = [];
          u.task.pathIndex = 0;
          u.targetSpeed = 0;
          const lastPing = this.lastFire.get(`ping-${u.id}`) ?? -99;
          if (now - lastPing > DETECTION.PING_COOLDOWN) {
            if (this.emissionsAllowActive() && sim.ping(u.id)) this.lastFire.set(`ping-${u.id}`, now);
          }
        }
      } else if (t.kind === "jam") {
        if (d < DETECTION.JAM_RADIUS * 0.85) {
          const lastJam = this.lastFire.get(`jam-${u.id}`) ?? -99;
          if (now - lastJam > DETECTION.JAM_COOLDOWN - 2) {
            if (this.emissionsAllowActive() && sim.jam(u.id)) this.lastFire.set(`jam-${u.id}`, now);
          }
        }
      }
    }
  }

  /** Keep follow-type tasks (escort, repair) pointed at moving targets. */
  private refreshFollowTasks(now: number) {
    const sim = this.sim;
    for (const u of sim.units) {
      if (!this.isCommandReachable(u)) continue;
      const t = u.task;
      if (t.kind !== "escort" && t.kind !== "repair" && t.kind !== "rescue") continue;
      const target = t.targetId ? sim.unit(t.targetId) : null;
      if (!target) continue;
      const last = this.followRefresh.get(u.id) ?? -99;
      if (now - last < 3) continue;
      const goal = t.kind === "escort" ? offsetFrom(target.pos, u.pos, 85) : { ...target.pos };
      const cur = t.path.length > 0 ? t.path[t.path.length - 1] : null;
      if (!cur || distXZ(cur, goal) > 70) {
        const p = sim.nav.findPath(u.pos, goal, (x, z) => sim.dangerAt(x, z));
        if (p) {
          t.path = p;
          t.pathIndex = 0;
        }
        this.followRefresh.set(u.id, now);
      }
    }
  }

  /** Auto-complete one-shot player orders. */
  private checkOrderCompletion() {
    const sim = this.sim;
    const order = sim.fleetOrder;
    if (!order || !order.pos) return;
    if (order.kind === "investigate" || order.kind === "advance") {
      const anyNear = sim.units.some((u) => u.state === "active" && distXZ(u.pos, order.pos!) < 100);
      if (anyNear && sim.now - order.issuedAt > 10) {
        sim.emit("objectiveDone", order.kind === "investigate" ? "Investigation complete." : "Advance position reached.", { ...order.pos });
        sim.fleetOrder = null;
        this.lastOrderSeen = "none"; // suppress a duplicate "order cleared" entry
        this.logCommand("completed", null, `Player order completed: ${order.kind}.`, { ...order.pos });
        this.replanNeeded = true;
        this.replanReason = "order complete";
      }
    }
  }

  private log(text: string) {
    this.decisions.push({ time: this.sim.now, text });
    if (this.decisions.length > 40) this.decisions.splice(0, this.decisions.length - 40);
  }

  /** Append to the structured command timeline; merges rapid repeats per unit+kind. */
  private logCommand(kind: CommandEventKind, unitId: string | null, text: string, pos: Vec3 | null) {
    const last = this.commandLog[this.commandLog.length - 1];
    if (last && last.kind === kind && last.unitId === unitId && last.text === text && this.sim.now - last.time < 3) {
      return;
    }
    this.commandLog.push({ time: this.sim.now, kind, unitId, text, pos });
    if (this.commandLog.length > 60) this.commandLog.splice(0, this.commandLog.length - 60);
  }
}

function requiredHalfWidth(u: Unit, margin: number): number {
  const s = spec(u.role);
  const turningAllowance = Math.min(4, s.length / 24);
  const stoppingAllowance = (s.cruiseSpeed * s.cruiseSpeed) / Math.max(1, 2 * s.accel * 12);
  return s.radius + margin + turningAllowance + stoppingAllowance;
}

function directiveRiskMultiplier(risk: string): number {
  return risk === "conservative" ? 1.6 : risk === "mission" ? 0.45 : 1;
}

function directiveDepthMeters(depth: string): number {
  return depth === "shallow" ? 42 : depth === "deep" ? WORLD.MAX_DEPTH - 24 : depth === "terrain" ? WORLD.MAX_DEPTH : WORLD.CRUISE_DEPTH;
}

function directiveFormationRadius(formation: string): number {
  return formation === "search" ? 260 : formation === "escort" ? 52 : formation === "ring" ? 110 : formation === "line" ? 150 : 90;
}

function pathLength(points: Vec3[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += distXZ(points[i - 1], points[i]);
  return d;
}

function offsetCorridor(points: Vec3[], offset: number): Vec3[] {
  if (offset === 0) return points.map((p) => ({ ...p }));
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const dx = b.x - a.x; const dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
    const taper = points.length <= 1 ? 0 : Math.sin((i / (points.length - 1)) * Math.PI);
    return { x: p.x - (dz / d) * offset * taper, y: p.y, z: p.z + (dx / d) * offset * taper };
  });
}

function centroid(units: Unit[]): Vec3 {
  if (units.length === 0) return vec3(0, -100, 0);
  let x = 0;
  let y = 0;
  let z = 0;
  for (const u of units) {
    x += u.pos.x;
    y += u.pos.y;
    z += u.pos.z;
  }
  return vec3(x / units.length, y / units.length, z / units.length);
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return vec3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

function aheadOf(from: Vec3, toward: Vec3, dist: number): Vec3 {
  const dx = toward.x - from.x;
  const dz = toward.z - from.z;
  const m = Math.hypot(dx, dz) || 1;
  return vec3(from.x + (dx / m) * dist, from.y, from.z + (dz / m) * dist);
}

function offsetFrom(anchor: Vec3, from: Vec3, dist: number): Vec3 {
  const dx = from.x - anchor.x;
  const dz = from.z - anchor.z;
  const m = Math.hypot(dx, dz);
  if (m < 1) return vec3(anchor.x + dist, anchor.y, anchor.z);
  return vec3(anchor.x + (dx / m) * dist, anchor.y, anchor.z + (dz / m) * dist);
}

/** Where does a task want the unit to end up? */
function taskGoal(
  t: { kind: TaskKind; targetId: string | null; pos: Vec3 | null },
  sim: Simulation
): Vec3 | null {
  if (t.kind === "escort" || t.kind === "repair" || t.kind === "rescue") {
    const target = t.targetId ? sim.unit(t.targetId) : null;
    return target ? target.pos : null;
  }
  if (t.kind === "attack" && t.pos) {
    // standoff position toward fleet centroid
    const c = centroid(sim.units);
    const dx = c.x - t.pos.x;
    const dz = c.z - t.pos.z;
    const m = Math.hypot(dx, dz) || 1;
    return vec3(t.pos.x + (dx / m) * COMBAT.ATTACK_STANDOFF, t.pos.y, t.pos.z + (dz / m) * COMBAT.ATTACK_STANDOFF);
  }
  return t.pos;
}
