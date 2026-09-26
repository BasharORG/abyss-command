import { CameraMode } from "../render/cameras";
import { LabelMode } from "../render/worldview";
import { Nereus } from "../ai/nereus";
import { Simulation } from "../sim/simulation";
import { spec } from "../sim/units";
import { OperatorCommand } from "../command/controller";
import { FocusTrap } from "./focusTrap";
import { TutorialContext, TutorialController, TutorialEvent } from "./tutorial";
import {
  Doctrine,
  FleetOrderKind,
  GameSpeed,
  SimEvent,
  Unit,
  Vec3,
  CanyonTrialState
  ,MinefieldState
  ,FleetDirectives
  ,NetworkPolicy
  ,CommunicationPosture
} from "../types";
import { DOCTRINE, WORLD } from "../config";
import {
  COMMANDER_STATE_LABELS,
  DOCTRINE_LABELS,
  ORDER_LABELS,
  STATUS_LABELS,
  UnitCommand,
  commanderState,
  orderedSpeed,
  speedOrderLabel,
  unitCommand
} from "./telemetry";

export interface HudCallbacks {
  onSelectUnit(id: string | null): void;
  onDoctrine(d: Doctrine): void;
  onOrder(kind: FleetOrderKind): void;
  onClearOrder(): void;
  onSpeed(s: GameSpeed): void;
  onCameraMode(m: CameraMode): void;
  onPing(): void;
  onJam(): void;
  onOpenMenu(): void;
  onToggleMute(): void;
  /** focus a world position (timeline entry click) */
  onFocusPoint(pos: Vec3): void;
  onToggleAIOrders(on: boolean): void;
  onStartObstacleTrial(): void;
  onTrialSettings(settings: Partial<Pick<CanyonTrialState, "priority" | "coordination" | "clearanceMargin" | "speedLimit" | "held">>): void;
  onTrialObstruction(): void;
  onResetTrial(): void;
  onControlCenterWidth(width: number): void;
  onLabelMode(mode: LabelMode): void;
  onStartMinefield(seed: string): void;
  onMinefieldSettings(settings: Partial<Pick<MinefieldState,"posture"|"policy"|"formation"|"clearance"|"held"|"scanStarted"|"crossingStarted"|"retreat"|"neutralizationAuthorized"|"neutralizationCancelled">>): void;
  onReleaseDriftingMine(): void;
  onManualMode(enabled:boolean): void;
  onFleetDirectives(settings:Partial<FleetDirectives>):void;
  onSpecialCommand(command:string):void;
  onStartHandoffTrial():void;
  onStartDefense():void;
  onDefenseSettings(settings:Record<string,string|number>):void;
  onReinforcement():void;
  onStartDivide():void;
  onNetworkPolicy(policy:NetworkPolicy,posture:CommunicationPosture):void;
  onDeployRelay():void;
  onActivateJammer():void;
  onConsoleCommand(input:string):void;
  onConsoleConfirm():void;
  onConsoleCancel():void;
  onStartCrown():void;
  onLogisticsPolicy(settings:Partial<import("../types").LogisticsPolicy>):void;
  onTouchAction(action:"selectPrevious"|"selectNext"|"camera"|"pause"|"manual"|"sonar"|"countermeasure"|"roleAction"):void;
  onTouchHold(action:"throttleUp"|"throttleDown"|"steerLeft"|"steerRight"|"ascend"|"descend",active:boolean):void;
}

const ROLE_DESCS: Record<string, string> = {
  ATLAS: "Command & heavy support",
  GHOST: "Stealth reconnaissance",
  LANCER: "Tactical defense",
  ECHO: "Survey & electronic support",
  MENDER: "Engineering & rescue"
};

function fmtTime(s: number): string {
  const m = Math.floor(Math.max(0, s) / 60);
  const sec = Math.floor(Math.max(0, s) % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export class Hud {
  private root: HTMLElement;
  private cb: HudCallbacks;
  private els!: {
    objective: HTMLElement;
    clock: HTMLElement;
    muteBtn: HTMLButtonElement;
    roster: HTMLElement;
    unitCards: Map<string, HTMLElement>;
    nereusPlan: HTMLElement;
    nereusState: HTMLElement;
    nereusObjective: HTMLElement;
    nereusDoctrine: HTMLElement;
    nereusOrder: HTMLElement;
    timeline: HTMLElement;
    nereusBody: HTMLElement;
    aiOrdersBtn: HTMLButtonElement;
    eventFeed: HTMLElement;
    detail: HTMLElement;
    toast: HTMLElement | null;
    minimap: HTMLCanvasElement;
    speedBtns: HTMLButtonElement[];
    camBtns: HTMLButtonElement[];
    doctrineBtns: HTMLButtonElement[];
    orderBtns: Map<FleetOrderKind, HTMLButtonElement>;
    controlsOverlay: HTMLElement;
    labelBtn: HTMLButtonElement;
    controlCenter: HTMLElement;
    trialModule: HTMLElement;
    trialRoutes: HTMLElement;
    trialPlan: HTMLElement;
    trialStart: HTMLButtonElement;
    threatModule: HTMLElement;
    modeButtons: HTMLButtonElement[];
    directivesModule: HTMLElement;
    defenseModule: HTMLElement;
    networkModule: HTMLElement;
    commandConsole: HTMLElement;
    crownStrip: HTMLElement;
    logisticsModule: HTMLElement;
    tutorial: HTMLElement;
    performance: HTMLElement;
    touchControls:HTMLElement;
  };
  private mmBg: HTMLCanvasElement | null = null;
  private lastUpdate = 0;
  private lastMinimap = 0;
  private lastTimelineKey = "";
  private prevOrderKind: FleetOrderKind | null = null;
  private orderClearedByUser = false;
  private orderFlash: { text: string; until: number } | null = null;
  private aiOrdersOn = true;
  private labelMode: LabelMode = "all";
  private forceUpdate = false;
  private controlsTrap:FocusTrap|null=null;
  private tutorial=new TutorialController();
  private tutorialTarget:HTMLElement|null=null;
  armedOrder: FleetOrderKind | null = null;
  muted = false;

  constructor(root: HTMLElement, cb: HudCallbacks) {
    this.root = root;
    this.cb = cb;
  }

  build(sim: Simulation) {
    this.root.innerHTML = "";
    this.root.classList.remove("hidden");
    // restart-safe: the game clock resets to zero on restart
    this.lastUpdate = 0;
    this.lastMinimap = 0;
    this.lastTimelineKey = "";
    this.prevOrderKind = null;
    this.orderClearedByUser = false;
    this.orderFlash = null;
    this.armedOrder = null;
    this.mmBg = null;
    const el = (tag: string, cls?: string, html?: string) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html !== undefined) e.innerHTML = html;
      return e;
    };
    const btn = (label: string, title: string, onClick: () => void, cls = "") => {
      const b = document.createElement("button");
      b.className = cls;
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", onClick);
      return b;
    };

    // --- top bar ---
    const topBar = el("div", "top-bar");
    const objective = el("div", "objective", `<div class="label">Mission Objective</div><div class="text"></div>`);
    const clock = el("div", "clock", `<div class="label">Storm window</div><div class="time">0:00</div>`);
    const topControls = el("div", "top-controls");
    const speedControls = el("div", "speed-controls");
    const speedBtns: HTMLButtonElement[] = [
      btn("⏸", "Pause (Space)", () => this.cb.onSpeed(0)),
      btn("▶", "Normal speed (Space)", () => this.cb.onSpeed(1)),
      btn("⏩", "Double speed (F)", () => this.cb.onSpeed(2))
    ];
    speedBtns.forEach((b) => speedControls.appendChild(b));
    const camBtns: HTMLButtonElement[] = [
      btn("Cine", "Cinematic camera (C)", () => this.cb.onCameraMode("cinematic")),
      btn("Follow", "Follow selected submarine (C)", () => this.cb.onCameraMode("follow")),
      btn("Tactical", "Tactical overview (C)", () => this.cb.onCameraMode("tactical"))
    ];
    camBtns.forEach((b) => topControls.appendChild(b));
    const aiOrdersBtn = btn("Orders", "Show AI order overlays: planned routes, destinations, task labels (O)", () =>
      this.toggleAIOrders()
    );
    aiOrdersBtn.classList.toggle("active", this.aiOrdersOn);
    aiOrdersBtn.setAttribute("aria-pressed", String(this.aiOrdersOn));
    topControls.appendChild(aiOrdersBtn);
    const labelBtn = btn("Labels: All", "Cycle labels: All, Selected, Off (L)", () => this.toggleLabelMode());
    topControls.appendChild(labelBtn);
    const muteBtn = btn("Snd", "Mute (M)", () => this.cb.onToggleMute());
    const menuBtn = btn("Menu", "Pause menu (Esc)", () => this.cb.onOpenMenu());
    const helpBtn = btn("?", "Controls (H)", () => this.toggleControls());
    topControls.append(...camBtns, muteBtn, helpBtn, menuBtn);
    const timeCluster = el("div", "time-cluster");
    timeCluster.append(clock, speedControls, topControls);
    topBar.append(objective, timeCluster);

    // --- roster ---
    const roster = el("div", "roster");
    const unitCards = new Map<string, HTMLElement>();
    sim.units.forEach((u, i) => {
      const card = el(
        "div",
        "unit-card",
        `<div class="row1"><span class="callsign">${u.callsign}</span>
           <span><span class="status-chip"></span> <span class="hullno">${u.hullNumber}</span> <span class="key-hint">${i + 1}</span></span></div>
         <div class="task"></div>
         <div class="target"></div>
         <div class="bars">
           <span class="bar-label">HUL</span><div class="bar hull"><i></i></div>
           <span class="bar-label">BAT</span><div class="bar batt"><i></i></div>
         </div>`
      );
      card.addEventListener("click", () => {this.cb.onSelectUnit(u.id);this.tutorialEvent("unit-selected");});
      roster.appendChild(card);
      unitCards.set(u.id, card);
    });

    // --- bottom bar: doctrine + orders ---
    const bottomBar = el("div", "bottom-bar");
    const doctrineGroup = el("div", "group", `<div class="group-label">Doctrine</div>`);
    const doctrineButtons = el("div", "buttons");
    const doctrineBtns: HTMLButtonElement[] = (["silent", "balanced", "urgent"] as Doctrine[]).map((d) => {
      const b = btn(DOCTRINE[d].label, DOCTRINE[d].desc, () => this.cb.onDoctrine(d));
      b.dataset.doctrine = d;
      doctrineButtons.appendChild(b);
      return b;
    });
    doctrineGroup.appendChild(doctrineButtons);
    const ordersGroup = el("div", "group", `<div class="group-label">Fleet Orders</div>`);
    const orderButtons = el("div", "buttons");
    const orderBtns = new Map<FleetOrderKind, HTMLButtonElement>();
    const orders: [FleetOrderKind, string, string][] = [
      ["advance", "Advance", "Fleet advances on a point you mark"],
      ["regroup", "Regroup", "Fleet forms up on Atlas"],
      ["hold", "Hold", "All units hold position"],
      ["repairs", "Repairs", "Mender prioritizes repairs"],
      ["investigate", "Investigate", "Send a scout to a point you mark"],
      ["extract", "Extract", "All units proceed to extraction"]
    ];
    for (const [kind, label, tip] of orders) {
      const b = btn(label, tip, () => this.cb.onOrder(kind));
      b.dataset.order = kind;
      orderBtns.set(kind, b);
      orderButtons.appendChild(b);
    }
    const clearBtn = btn("Resume Autonomy", "Clear fleet order — NEREUS resumes the mission plan (not a pause)", () => {
      this.orderClearedByUser = true;
      this.cb.onClearOrder();
    });
    orderButtons.appendChild(clearBtn);
    ordersGroup.appendChild(orderButtons);
    bottomBar.append(doctrineGroup, ordersGroup);

    // --- minimap ---
    const minimapWrap = el("div", "minimap-wrap");
    const minimapToggle = btn("Sonar ▾", "Show or hide tactical sonar", () => {
      minimapWrap.classList.toggle("collapsed");
      minimapToggle.textContent = minimapWrap.classList.contains("collapsed") ? "Sonar ▸" : "Sonar ▾";
      minimapToggle.setAttribute("aria-expanded", String(!minimapWrap.classList.contains("collapsed")));
    }, "minimap-toggle");
    minimapToggle.setAttribute("aria-expanded", "true");
    const minimap = document.createElement("canvas");
    minimap.id = "minimap";
    minimap.width = 216 * 2;
    minimap.height = 216 * 2;
    minimapWrap.append(minimapToggle, minimap);

    // --- NEREUS live command panel ---
    const nereusPanel = el("div", "nereus-panel");
    const header = el(
      "button",
      "header",
      `<span class="title">NEREUS — LIVE COMMAND</span><span class="state-pill"></span><span class="chevron">▾</span>`
    );
    header.setAttribute("aria-expanded", "true");
    const nereusBody = el("div", "body");
    const nereusState = header.querySelector(".state-pill") as HTMLElement;
    const statusGrid = el(
      "div",
      "cmd-status",
      `<div class="row"><span>Objective</span><b class="cs-objective"></b></div>
       <div class="row"><span>Doctrine</span><b class="cs-doctrine"></b></div>
       <div class="row"><span>Fleet order</span><b class="cs-order"></b></div>
       <div class="row"><span>Latest</span><b class="cs-latest"></b></div>`
    );
    const crownStrip=el("div","crown-phase-strip");
    const nereusDoctrine = statusGrid.querySelector(".cs-doctrine") as HTMLElement;
    const nereusOrder = statusGrid.querySelector(".cs-order") as HTMLElement;
    const nereusPlan = statusGrid.querySelector(".cs-latest") as HTMLElement;
    const timelineLabel = el("div", "timeline-label", "COMMAND TIMELINE");
    const timeline = el("div", "timeline");
    timeline.addEventListener("click", (ev) => {
      const entry = (ev.target as HTMLElement).closest(".tl-entry") as HTMLElement | null;
      if (!entry) return;
      const unitId = entry.dataset.unit;
      if (unitId) {
        this.cb.onSelectUnit(unitId);
        return;
      }
      if (entry.dataset.pos) {
        const [x, y, z] = entry.dataset.pos.split(",").map(Number);
        this.cb.onFocusPoint({ x, y, z });
      }
    });
    nereusBody.append(statusGrid,crownStrip);
    header.addEventListener("click", () => {
      nereusBody.classList.toggle("hidden");
      const expanded = !nereusBody.classList.contains("hidden");
      nereusPanel.classList.toggle("collapsed", !expanded);
      header.setAttribute("aria-expanded", String(expanded));
      const chevron = header.querySelector(".chevron");
      if (chevron) chevron.textContent = expanded ? "▾" : "▸";
      if(expanded)this.tutorialEvent("autonomy-observed");
    });
    nereusPanel.append(header, nereusBody);

    // --- unit detail ---
    const detail = el("div", "unit-detail hidden");

    // --- event feed ---
    const eventFeed = el("div", "event-feed");

    // --- obstacle navigation module ---
    const trialModule = el(
      "div",
      "trial-module",
      `<button class="trial-start primary">Start Obstacle Trial</button>
       <div class="trial-controls hidden">
         <div class="trial-state"><span>Scenario</span><b>Canyon Passage</b></div>
         <label>Navigation priority
           <select data-trial="priority" title="Choose the shortest safe route or favor the route with the most clearance.">
             <option value="safest">Safest passage</option><option value="fastest">Fastest valid passage</option>
           </select>
         </label>
         <label>Fleet coordination
           <select data-trial="coordination" title="Keep all vessels on one common route or permit a temporary split followed by regrouping.">
             <option value="together">Keep fleet together</option><option value="split">Allow temporary split</option>
           </select>
         </label>
         <label>Clearance margin <output data-out="clearance">6 m</output>
           <input data-trial="clearance" type="range" min="2" max="12" step="1" value="6" title="Additional world-space clearance required around each hull." />
         </label>
         <label>Passage speed limit <output data-out="speed">7 m/s</output>
           <input data-trial="speed" type="range" min="3" max="12" step="1" value="7" title="Maximum speed NEREUS may command inside the obstacle area." />
         </label>
         <div class="trial-actions">
           <button data-trial-act="hold" title="Bring the fleet to a safe stop without changing the route strategy.">Hold fleet</button>
           <button data-trial-act="resume" title="Resume execution of the current safe route plan.">Resume navigation</button>
           <button data-trial-act="reevaluate" title="Ask NEREUS to apply the current constraints and issue a fresh plan.">Re-evaluate routes</button>
           <button data-trial-act="obstruct" title="Introduce a detected rockfall ahead of the fleet to test replanning.">Introduce New Obstruction</button>
           <button data-trial-act="reset" title="Reset submarines, routes, reservations, obstruction, and history.">Reset trial</button>
         </div>
         <div class="trial-plan"></div>
         <div class="trial-routes"></div>
       </div>`
    );
    const trialStart = trialModule.querySelector(".trial-start") as HTMLButtonElement;
    const trialPlan = trialModule.querySelector(".trial-plan") as HTMLElement;
    const trialRoutes = trialModule.querySelector(".trial-routes") as HTMLElement;
    trialStart.addEventListener("click", () => this.cb.onStartObstacleTrial());
    const threatModule=el("div","threat-module",`<button class="minefield-start primary">Start Silent Minefield</button><div class="threat-controls hidden">
      <div class="trial-state"><span>Posture</span><b data-threat-status>Awaiting trial</b></div>
      <label>Response policy<select data-threat="policy"><option value="avoid">Avoid all confirmed threats</option><option value="blockingOnly">Disable blocking threats only</option><option value="shortest">Clear shortest safe corridor</option></select></label>
      <label>Detection posture<select data-threat="posture"><option value="passive">Passive first</option><option value="balanced">Balanced scanning</option><option value="maximum">Maximum awareness</option></select></label>
      <label>Crossing formation<select data-threat="formation"><option value="single">Single file</option><option value="paired">Paired crossing</option><option value="auto">NEREUS decides</option></select></label>
      <label>Minimum threat clearance <output data-threat-out="clearance">38 m</output><input data-threat="clearance" type="range" min="20" max="90" step="5" value="38" /></label>
      <div class="trial-actions"><button data-threat-act="scan">Begin scan</button><button data-threat-act="hold">Hold fleet</button><button data-threat-act="cross">Begin crossing</button><button data-threat-act="reeval">Re-evaluate corridors</button><button data-threat-act="authorize">Authorize neutralization</button><button data-threat-act="cancel">Cancel neutralization</button><button data-threat-act="drift">Release Drifting Mine</button><button data-threat-act="retreat">Emergency retreat</button><button data-threat-act="reset">Reset trial</button></div>
      <div class="threat-summary"></div><canvas class="threat-map" width="300" height="180"></canvas><div class="contact-inspector"></div>
    </div>`);
    threatModule.querySelector(".minefield-start")?.addEventListener("click",()=>this.cb.onStartMinefield(`MINEFIELD-${Math.floor(Math.random()*900+100)}`));
    const threatSettings=()=>{const clearance=Number((threatModule.querySelector('[data-threat="clearance"]') as HTMLInputElement).value);(threatModule.querySelector('[data-threat-out="clearance"]') as HTMLOutputElement).value=`${clearance} m`;this.cb.onMinefieldSettings({policy:(threatModule.querySelector('[data-threat="policy"]') as HTMLSelectElement).value as MinefieldState["policy"],posture:(threatModule.querySelector('[data-threat="posture"]') as HTMLSelectElement).value as MinefieldState["posture"],formation:(threatModule.querySelector('[data-threat="formation"]') as HTMLSelectElement).value as MinefieldState["formation"],clearance});this.forceUpdate=true;};
    threatModule.querySelectorAll("select,input").forEach(x=>x.addEventListener("change",threatSettings));
    const threatAct=(name:string,settings:Parameters<HudCallbacks["onMinefieldSettings"]>[0])=>threatModule.querySelector(`[data-threat-act="${name}"]`)?.addEventListener("click",()=>{this.cb.onMinefieldSettings(settings);this.forceUpdate=true;});
    threatAct("scan",{scanStarted:true});threatAct("hold",{held:true});threatAct("cross",{crossingStarted:true,held:false});threatAct("reeval",{});threatAct("authorize",{neutralizationAuthorized:true,neutralizationCancelled:false});threatAct("cancel",{neutralizationCancelled:true,neutralizationAuthorized:false});threatAct("retreat",{retreat:true});
    threatModule.querySelector('[data-threat-act="drift"]')?.addEventListener("click",()=>this.cb.onReleaseDriftingMine());
    threatModule.querySelector('[data-threat-act="reset"]')?.addEventListener("click",()=>this.cb.onStartMinefield(`MINEFIELD-${Math.floor(Math.random()*900+100)}`));
    const emitTrialSettings = () => {
      const priority = (trialModule.querySelector('[data-trial="priority"]') as HTMLSelectElement).value as CanyonTrialState["priority"];
      const coordination = (trialModule.querySelector('[data-trial="coordination"]') as HTMLSelectElement).value as CanyonTrialState["coordination"];
      const clearanceMargin = Number((trialModule.querySelector('[data-trial="clearance"]') as HTMLInputElement).value);
      const speedLimit = Number((trialModule.querySelector('[data-trial="speed"]') as HTMLInputElement).value);
      (trialModule.querySelector('[data-out="clearance"]') as HTMLOutputElement).value = `${clearanceMargin} m`;
      (trialModule.querySelector('[data-out="speed"]') as HTMLOutputElement).value = `${speedLimit} m/s`;
      this.cb.onTrialSettings({ priority, coordination, clearanceMargin, speedLimit });
      this.forceUpdate = true;
    };
    trialModule.querySelectorAll("select,input").forEach((input) => input.addEventListener("change", emitTrialSettings));
    trialModule.querySelector('[data-trial-act="hold"]')?.addEventListener("click", () => { this.cb.onTrialSettings({ held: true }); this.forceUpdate = true; });
    trialModule.querySelector('[data-trial-act="resume"]')?.addEventListener("click", () => { this.cb.onTrialSettings({ held: false }); this.forceUpdate = true; });
    trialModule.querySelector('[data-trial-act="reevaluate"]')?.addEventListener("click", emitTrialSettings);
    trialModule.querySelector('[data-trial-act="obstruct"]')?.addEventListener("click", () => { this.cb.onTrialObstruction(); this.forceUpdate = true; });
    trialModule.querySelector('[data-trial-act="reset"]')?.addEventListener("click", () => this.cb.onResetTrial());

    // --- permanent left control center ---
    const controlCenter = el("aside", "control-center");
    const ccHeader = el("div", "cc-header", `<div><span class="cc-kicker">CENTRAL COMMAND AI</span><h2>NEREUS CONTROL CENTER</h2></div>`);
    const modeBar=el("div","control-mode-bar");
    const autonomy=btn("Autonomy","NEREUS controls all five submarines",()=>this.cb.onManualMode(false),"active");
    const manual=btn("Manual Intervention","Directly pilot the selected submarine",()=>this.cb.onManualMode(true));
    modeBar.append(autonomy,manual);
    const collapse = btn(controlCenter.classList.contains("collapsed") ? "›" : "‹", "Collapse control center", () => {
      controlCenter.classList.toggle("collapsed");
      this.root.classList.toggle("cc-collapsed", controlCenter.classList.contains("collapsed"));
      collapse.textContent = controlCenter.classList.contains("collapsed") ? "›" : "‹";
      collapse.setAttribute("aria-expanded", String(!controlCenter.classList.contains("collapsed")));
      this.syncViewportInset();
    }, "cc-collapse");
    collapse.setAttribute("aria-expanded", String(!controlCenter.classList.contains("collapsed")));
    ccHeader.append(collapse);
    const section = (title: string, body: HTMLElement, cls = "", tutorialEvent?:TutorialEvent) => {
      const s = el("section", `cc-section ${cls}`.trim());
      const h = el("button", "cc-section-head", `<span>${title}</span><span>−</span>`);
      h.setAttribute("aria-expanded", "true");
      h.addEventListener("click", () => {
        body.classList.toggle("hidden");
        const open = !body.classList.contains("hidden");
        h.setAttribute("aria-expanded", String(open));
        h.lastElementChild!.textContent = open ? "−" : "+";
        if(open&&tutorialEvent)this.tutorialEvent(tutorialEvent);
      });
      body.classList.add("cc-section-body");
      if(tutorialEvent){body.addEventListener("pointerdown",()=>this.tutorialEvent(tutorialEvent));body.addEventListener("focusin",()=>this.tutorialEvent(tutorialEvent));}
      s.append(h, body);
      return s;
    };
    const fleetBody = el("div");
    fleetBody.append(roster, detail, minimapWrap);
    detail.addEventListener("pointerdown",()=>this.tutorialEvent("assignment-opened"));
    detail.addEventListener("focusin",()=>this.tutorialEvent("assignment-opened"));
    const historyBody = el("div");
    historyBody.append(timelineLabel, timeline, eventFeed);
    const directivesModule=el("div","directives-module",`<div class="directive-grid"><label>Formation<select data-dir="formation"><option value="auto">NEREUS decides</option><option value="line">Line ahead</option><option value="wedge">Wedge</option><option value="ring">Defensive ring</option><option value="search">Wide search</option><option value="escort">Tight escort</option></select></label><label>Fleet speed<select data-dir="speed"><option value="auto">NEREUS decides</option><option value="silent">Silent</option><option value="cruise">Cruise</option><option value="flank">Flank</option><option value="slowest">Match slowest</option></select></label><label>Depth strategy<select data-dir="depth"><option value="auto">NEREUS decides</option><option value="shallow">Shallow</option><option value="mid">Midwater</option><option value="deep">Deep</option><option value="terrain">Terrain following</option></select></label><label>Emissions<select data-dir="emissions"><option value="auto">NEREUS decides</option><option value="passive">Passive only</option><option value="needed">Active when needed</option><option value="maximum">Maximum awareness</option></select></label><label>Cohesion<select data-dir="cohesion"><option value="together">Stay together</option><option value="groups">Allow task groups</option><option value="independent">Independent assignments</option></select></label><label>Risk tolerance<select data-dir="risk"><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="mission">Mission focused</option></select></label></div><div class="special-commands"><button data-special="focus">Focus Point</button><button data-special="investigate">Investigate Area</button><button data-special="shadow">Shadow Selected</button><button data-special="escort">Protective Escort</button><button data-special="disperse">Emergency Disperse</button><button data-special="regroup">Emergency Regroup</button><button data-special="silent">Silent Running</button><button data-special="detect">Maximum Detection</button><button data-special="rescue">Rescue Selected</button><button data-special="abort">Abort Current Plan</button></div></div>`);
    const emitDirectives=()=>{const values={} as Record<string,string>;directivesModule.querySelectorAll<HTMLSelectElement>("[data-dir]").forEach(s=>values[s.dataset.dir!]=s.value);this.cb.onFleetDirectives(values as unknown as Partial<FleetDirectives>);this.tutorialEvent("directive-changed");};directivesModule.querySelectorAll("select").forEach(s=>s.addEventListener("change",emitDirectives));
    const handoff=btn("Start Command Handoff Trial","Short manual-control training scenario",()=>this.cb.onStartHandoffTrial(),"handoff-start primary");directivesModule.prepend(handoff);
    directivesModule.querySelectorAll<HTMLButtonElement>("[data-special]").forEach(button=>button.addEventListener("click",()=>this.cb.onSpecialCommand(button.dataset.special!)));
    const defenseModule=el("div","defense-module",`<button class="defense-start primary">Start Ambush at Echo Ridge</button><div class="defense-controls hidden"><div class="trial-state"><span>Alert</span><b data-defense-alert>NORMAL</b></div><label>Rules of engagement<select data-defense="roe"><option value="evade">Evade only</option><option value="defensive">Defensive action</option><option value="proactive">Proactive intercept</option></select></label><label>Protection priority<select data-defense="protection"><option value="auto">NEREUS decides</option><option value="carrier">Objective carrier</option><option value="damaged">Most damaged</option><option value="atlas">Atlas</option><option value="fleet">Whole fleet</option></select></label><label>Defensive posture<select data-defense="posture"><option value="silent">Silent evasion</option><option value="balanced">Balanced defense</option><option value="aggressive">Aggressive defense</option></select></label><label>Formation<select data-defense="formation"><option value="auto">NEREUS decides</option><option value="screen">Screen</option><option value="escort">Escort box</option><option value="spread">Evasive spread</option><option value="masking">Terrain masking</option><option value="retreat">Retreat column</option></select></label><label>Withdrawal threshold<input data-defense="withdrawalThreshold" type="range" min="20" max="80" value="45"/></label><button data-defense-act="reinforce">Introduce Reinforcement</button><div class="defense-plan"></div></div>`);defenseModule.querySelector(".defense-start")?.addEventListener("click",()=>this.cb.onStartDefense());const emitDefense=()=>{const out:Record<string,string|number>={};defenseModule.querySelectorAll<HTMLSelectElement>("select[data-defense]").forEach(s=>out[s.dataset.defense!]=s.value);out.withdrawalThreshold=Number((defenseModule.querySelector('[data-defense="withdrawalThreshold"]') as HTMLInputElement).value);this.cb.onDefenseSettings(out);};defenseModule.querySelectorAll("select,input").forEach(x=>x.addEventListener("change",emitDefense));defenseModule.querySelector('[data-defense-act="reinforce"]')?.addEventListener("click",()=>this.cb.onReinforcement());
    const networkModule=el("div","network-module",`<button class="network-start primary">Start The Silent Divide</button><div class="network-controls"><label>Network policy<select data-network="policy"><option value="full">Maintain full connection</option><option value="degraded">Allow degraded links</option><option value="planned">Permit planned disconnection</option><option value="auto">NEREUS decides</option></select></label><label>Communication posture<select data-network="posture"><option value="burst">Silent burst communication</option><option value="balanced">Balanced communication</option><option value="continuous">Continuous command link</option></select></label><div class="trial-actions"><button data-network-act="relay">Deploy relay</button><button data-network-act="jammer">Activate Unknown Jammer</button></div><div class="network-summary"></div><canvas class="network-map" width="300" height="180"></canvas><div class="network-messages"></div></div>`);networkModule.querySelector(".network-start")?.addEventListener("click",()=>this.cb.onStartDivide());const emitNetwork=()=>this.cb.onNetworkPolicy((networkModule.querySelector('[data-network="policy"]') as HTMLSelectElement).value as NetworkPolicy,(networkModule.querySelector('[data-network="posture"]') as HTMLSelectElement).value as CommunicationPosture);networkModule.querySelectorAll("select").forEach(s=>s.addEventListener("change",emitNetwork));networkModule.querySelector('[data-network-act="relay"]')?.addEventListener("click",()=>this.cb.onDeployRelay());networkModule.querySelector('[data-network-act="jammer"]')?.addEventListener("click",()=>this.cb.onActivateJammer());
    const commandConsole=el("div","command-console",`<div class="console-head"><span>NEREUS COMMAND</span><span class="console-link">READY</span></div><form><input type="text" autocomplete="off" placeholder="Type a directive…" aria-label="NEREUS command"/><button type="submit">Send</button></form><div class="console-suggestions"><button type="button">Hold the fleet outside danger</button><button type="button">Use passive sensors and take the safer route</button><button type="button">Maintain communication with Mender</button></div><div class="console-preview"></div><div class="console-actions hidden"><button data-console="confirm">Confirm</button><button data-console="cancel">Cancel</button></div><div class="console-response"></div><div class="console-history"></div></div>`);const consoleInput=commandConsole.querySelector("input") as HTMLInputElement;commandConsole.querySelector("form")?.addEventListener("submit",e=>{e.preventDefault();if(consoleInput.value.trim()){this.cb.onConsoleCommand(consoleInput.value);consoleInput.value="";}});commandConsole.querySelectorAll<HTMLButtonElement>(".console-suggestions button").forEach(b=>b.addEventListener("click",()=>{consoleInput.value=b.textContent??"";this.cb.onConsoleCommand(consoleInput.value);}));commandConsole.querySelector('[data-console="confirm"]')?.addEventListener("click",()=>this.cb.onConsoleConfirm());commandConsole.querySelector('[data-console="cancel"]')?.addEventListener("click",()=>this.cb.onConsoleCancel());
    commandConsole.prepend(btn("Start Operation Abyssal Crown","Launch the integrated major operation",()=>this.cb.onStartCrown(),"crown-start primary"));
    const logisticsModule=el("div","logistics-module",`<div class="directive-grid"><label>Conservation<select data-logistics="conservation"><option value="conserve">Conserve resources</option><option value="balanced">Balanced use</option><option value="spend">Mission priority</option></select></label><label>Emergency reserve<input data-logistics="reserve" type="range" min="5" max="40" value="20"/><output>20%</output></label><label class="check"><input data-logistics="authorize" type="checkbox" checked/> Authorize scarce-resource use</label></div><div class="logistics-summary"></div></div>`);const emitLogistics=()=>this.cb.onLogisticsPolicy({conservation:(logisticsModule.querySelector('[data-logistics="conservation"]')as HTMLSelectElement).value as import("../types").LogisticsPolicy["conservation"],minimumReserve:Number((logisticsModule.querySelector('[data-logistics="reserve"]')as HTMLInputElement).value),authorizeScarce:(logisticsModule.querySelector('[data-logistics="authorize"]')as HTMLInputElement).checked});logisticsModule.querySelectorAll("select,input").forEach(x=>x.addEventListener("change",emitLogistics));
    controlCenter.append(
      ccHeader,
      modeBar,
      section("Commander overview", nereusPanel, "cc-overview"),
      section("Fleet Directives",directivesModule,"cc-directives"),
      section("Obstacle Navigation", trialModule, "cc-trial","obstacle-opened"),
      section("Threat Response", threatModule, "cc-threat","contacts-opened"),
      section("Defensive Operations", defenseModule, "cc-defense","defense-opened"),
      section("Fleet Network", networkModule, "cc-network","network-opened"),
      section("Logistics",logisticsModule,"cc-logistics","logistics-opened"),
      section("Fleet execution", fleetBody, "cc-fleet"),
      section("Decision history", historyBody, "cc-history")
    );

    // --- controls overlay ---
    const controlsOverlay = el(
      "div",
      "controls-overlay hidden",
      `<h3>CONTROLS</h3>
      <table>
        <tr><td>1 – 5</td><td>Select Atlas, Ghost, Lancer, Echo, Mender</td></tr>
        <tr><td>Click</td><td>Select submarine / mark order target</td></tr>
        <tr><td>Drag / Wheel</td><td>Orbit &amp; zoom camera</td></tr>
        <tr><td>C</td><td>Cycle camera mode</td></tr>
        <tr><td>Space</td><td>Pause / resume</td></tr>
        <tr><td>F</td><td>Double speed</td></tr>
        <tr><td>P</td><td>Active sonar ping (selected unit)</td></tr>
        <tr><td>J</td><td>Echo jam (when Echo selected)</td></tr>
        <tr><td>O</td><td>Toggle AI order overlays (routes, destinations, labels)</td></tr>
        <tr><td>L</td><td>Cycle labels: All, Selected, Off</td></tr>
        <tr><td>M</td><td>Enter / exit Manual Intervention</td></tr><tr><td>X</td><td>Deploy contextual countermeasure</td></tr>
        <tr><td>H</td><td>This overlay</td></tr>
        <tr><td>Esc</td><td>Pause menu</td></tr>
        <tr><td>Touch</td><td>Contextual fleet controls and full manual helm</td></tr>
        <tr><td>Gamepad</td><td>Left stick helm · triggers depth · bumpers select · face buttons act</td></tr>
      </table>`
    );
    const tutorial=el("aside","tutorial-card hidden",`<div class="tutorial-context">Contextual guidance</div><h3 class="tutorial-title"></h3><p class="tutorial-step"></p><div class="tutorial-actions"><span class="tutorial-progress"></span><button data-tutorial="skip">Dismiss guidance</button></div>`);tutorial.setAttribute("aria-live","polite");const dismiss=()=>{this.tutorial.skip();this.clearTutorial();};const skipBtn=tutorial.querySelector('[data-tutorial="skip"]') as HTMLButtonElement;skipBtn.addEventListener("pointerup",dismiss);skipBtn.addEventListener("click",dismiss);
    const performance=el("div","performance-display hidden","FPS — · Draws — · Triangles —");
    const touchControls=el("div","touch-controls",`<div class="touch-command"><button data-touch="selectPrevious" aria-label="Select previous submarine">Prev</button><button data-touch="selectNext" aria-label="Select next submarine">Next</button><button data-touch="camera">Camera</button><button data-touch="pause">Pause</button></div><div class="touch-manual"><div class="touch-pad"><button data-hold="throttleUp">Ahead</button><button data-hold="steerLeft">Port</button><button data-hold="throttleDown">Stop</button><button data-hold="steerRight">Starboard</button></div><div class="touch-depth"><button data-hold="ascend">Ascend</button><button data-hold="descend">Descend</button></div><div class="touch-actions"><button data-touch="sonar">Sonar</button><button data-touch="roleAction">Role action</button><button data-touch="countermeasure">Countermeasure</button><button data-touch="manual">Return</button></div></div>`);
    touchControls.querySelectorAll<HTMLButtonElement>("[data-touch]").forEach(button=>button.addEventListener("click",()=>this.cb.onTouchAction(button.dataset.touch as Parameters<HudCallbacks["onTouchAction"]>[0])));
    touchControls.querySelectorAll<HTMLButtonElement>("[data-hold]").forEach(button=>{const action=button.dataset.hold as Parameters<HudCallbacks["onTouchHold"]>[0];const set=(active:boolean)=>{button.classList.toggle("active",active);this.cb.onTouchHold(action,active);};button.addEventListener("pointerdown",event=>{event.preventDefault();button.setPointerCapture(event.pointerId);set(true);});for(const type of["pointerup","pointercancel","lostpointercapture"] as const)button.addEventListener(type,()=>set(false));});

    controlCenter.append(commandConsole);
    this.root.append(topBar, controlCenter, bottomBar, tutorial, performance, touchControls, controlsOverlay);

    this.els = {
      objective: objective.querySelector(".text")!,
      clock: clock.querySelector(".time")!,
      muteBtn,
      roster,
      unitCards,
      nereusPlan,
      nereusState,
      nereusObjective: statusGrid.querySelector(".cs-objective")!,
      nereusDoctrine,
      nereusOrder,
      timeline,
      nereusBody,
      aiOrdersBtn,
      eventFeed,
      detail,
      toast: null,
      minimap,
      speedBtns,
      camBtns,
      doctrineBtns,
      orderBtns,
      controlsOverlay,
      labelBtn,
      controlCenter,
      trialModule,
      trialRoutes,
      trialPlan,
      trialStart,
      threatModule,
      modeButtons:[autonomy,manual]
      ,directivesModule
      ,defenseModule
      ,networkModule
      ,commandConsole
      ,crownStrip
      ,logisticsModule
      ,tutorial
      ,performance
      ,touchControls
    };

    this.buildMinimapBackground(sim);
    this.root.classList.toggle("cc-collapsed", controlCenter.classList.contains("collapsed"));
    this.syncViewportInset();
  }

  tutorialEvent(event:TutorialEvent){if(this.tutorial.record(event))this.forceUpdate=true;}
  private clearTutorial(){this.tutorialTarget?.classList.remove("tutorial-target");this.tutorialTarget=null;if(this.els?.tutorial)this.els.tutorial.classList.add("hidden");}
  private updateTutorial(context:TutorialContext){const step=this.tutorial.current(context);if(!step){this.clearTutorial();return;}const target=this.root.querySelector(step.target) as HTMLElement|null;if(target!==this.tutorialTarget){this.tutorialTarget?.classList.remove("tutorial-target");this.tutorialTarget=target;target?.classList.add("tutorial-target");}this.els.tutorial.classList.remove("hidden");(this.els.tutorial.querySelector(".tutorial-title")as HTMLElement).textContent=step.title;(this.els.tutorial.querySelector(".tutorial-step")as HTMLElement).textContent=step.instruction;const progress=this.tutorial.progress;(this.els.tutorial.querySelector(".tutorial-progress")as HTMLElement).textContent=`${progress.done} of ${progress.total} discovered`;}

  syncViewportInset() {
    if (!this.els?.controlCenter) return;
    const compact = window.matchMedia("(max-width: 1000px)").matches;
    const collapsed = this.els.controlCenter.classList.contains("collapsed");
    this.cb.onControlCenterWidth(compact || collapsed ? 48 : 372);
  }

  setManualMode(enabled:boolean,callsign:string){this.els.modeButtons[0].classList.toggle("active",!enabled);this.els.modeButtons[1].classList.toggle("active",enabled);this.els.controlCenter.classList.toggle("manual-mode",enabled);this.els.touchControls.classList.toggle("manual-active",enabled);this.els.modeButtons[1].textContent=enabled?`Manual: ${callsign}`:"Manual Intervention";this.tutorialEvent(enabled?"manual-taken":"manual-returned");}
  updateCommandConsole(pending:OperatorCommand|null,history:OperatorCommand[],link:string){const preview=this.els.commandConsole.querySelector(".console-preview") as HTMLElement,actions=this.els.commandConsole.querySelector(".console-actions") as HTMLElement,response=this.els.commandConsole.querySelector(".console-response") as HTMLElement,status=this.els.commandConsole.querySelector(".console-link") as HTMLElement;status.textContent=link.toUpperCase();preview.textContent=pending?.response??"";actions.classList.toggle("hidden",!pending||pending.state!=="confirmation");response.textContent=history.at(-1)?.response??"NEREUS ready for validated directives.";(this.els.commandConsole.querySelector(".console-history") as HTMLElement).innerHTML=history.slice(-6).reverse().map(c=>`<button type="button"><b>${c.state}</b> ${escapeHtml(c.input)}</button>`).join("");}

  toggleControls() {
    this.els.controlsOverlay.classList.toggle("hidden");
    if(this.els.controlsOverlay.classList.contains("hidden")){this.controlsTrap?.deactivate();this.controlsTrap=null;}else{this.els.controlsOverlay.setAttribute("role","dialog");this.els.controlsOverlay.setAttribute("aria-modal","true");this.controlsTrap=new FocusTrap(this.els.controlsOverlay,()=>this.toggleControls());this.controlsTrap.activate();}
  }

  toggleAIOrders() {
    this.aiOrdersOn = !this.aiOrdersOn;
    this.els.aiOrdersBtn.classList.toggle("active", this.aiOrdersOn);
    this.els.aiOrdersBtn.setAttribute("aria-pressed", String(this.aiOrdersOn));
    this.cb.onToggleAIOrders(this.aiOrdersOn);
  }

  toggleLabelMode() {
    const modes: LabelMode[] = ["all", "selected", "off"];
    this.labelMode = modes[(modes.indexOf(this.labelMode) + 1) % modes.length];
    this.els.labelBtn.textContent = `Labels: ${this.labelMode === "all" ? "All" : this.labelMode === "selected" ? "Selected" : "Off"}`;
    this.cb.onLabelMode(this.labelMode);
  }

  get labelsVisible() {
    return this.labelMode;
  }

  get aiOrdersVisible() {
    return this.aiOrdersOn;
  }

  /** Fleet-order status line: armed / executing / completed / blocked / autonomy. */
  private orderStatusText(sim: Simulation, now: number): string {
    if (this.armedOrder) {
      return `${ORDER_LABELS[this.armedOrder]} — awaiting target mark (click the world)`;
    }
    if (sim.orderRefusal && sim.now < sim.orderRefusal.until) {
      return `Blocked — ${sim.orderRefusal.text}`;
    }
    const fo = sim.fleetOrder;
    if (fo) {
      return `${ORDER_LABELS[fo.kind]} — player order · executing`;
    }
    if (this.orderFlash && now < this.orderFlash.until) {
      return this.orderFlash.text;
    }
    return "Autonomy — NEREUS mission plan";
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.els.muteBtn.classList.toggle("active", muted);
    this.els.muteBtn.setAttribute("aria-pressed", String(muted));
  }

  setArmedOrder(kind: FleetOrderKind | null) {
    this.armedOrder = kind;
    for (const [k, b] of this.els.orderBtns) {
      b.classList.toggle("armed", k === kind);
    }
  }

  pushEvent(e: SimEvent) {
    const div = document.createElement("div");
    const important = ["objectiveDone", "coreRecovered", "coreDropped", "phaseChange", "nodeDisabled", "repairDone"];
    const danger = ["nodeAlert", "mineHit", "unitDamaged", "unitDisabled", "unitDestroyed", "warning"];
    div.className = "evt" + (danger.includes(e.kind) ? " danger" : important.includes(e.kind) ? " important" : "");
    div.textContent = `[${fmtTime(e.time)}] ${e.text}`;
    this.els.eventFeed.prepend(div);
    while (this.els.eventFeed.children.length > 6) {
      this.els.eventFeed.lastChild?.remove();
    }
  }

  update(sim: Simulation, nereus: Nereus, selectedId: string | null, speed: GameSpeed, camMode: CameraMode, now: number) {
    if (!this.els) return;
    if (!this.forceUpdate && now - this.lastUpdate < 0.12) return;
    this.forceUpdate = false;
    this.lastUpdate = now;

    // objective + clock
    this.els.objective.textContent = sim.objectiveText();
    this.els.clock.textContent = sim.canyonTrial || sim.minefield ? "TRAINING" : fmtTime(sim.timeRemaining);
    this.els.clock.className =
      "time" + (!sim.canyonTrial && !sim.minefield && sim.timeRemaining < 90 ? " critical" : !sim.canyonTrial && !sim.minefield && sim.timeRemaining < 240 ? " low" : "");

    // speed / camera button states
    this.els.speedBtns[0].classList.toggle("active", speed === 0);
    this.els.speedBtns[1].classList.toggle("active", speed === 1);
    this.els.speedBtns[2].classList.toggle("active", speed === 2);
    const modes: CameraMode[] = ["cinematic", "follow", "tactical"];
    this.els.camBtns.forEach((b, i) => b.classList.toggle("active", camMode === modes[i]));
    const doctrines: Doctrine[] = ["silent", "balanced", "urgent"];
    this.els.doctrineBtns.forEach((b, i) => b.classList.toggle("active", sim.doctrine === doctrines[i]));

    // roster cards: assigned task + target + live execution status
    for (const u of sim.units) {
      const card = this.els.unitCards.get(u.id)!;
      card.classList.toggle("selected", u.id === selectedId);
      card.classList.toggle("destroyed", u.state === "destroyed");
      card.classList.toggle("disabled-state", u.state === "disabled");
      const cmd = unitCommand(u, sim);
      const trialPlan = nereus.trialDecision?.units.find((p) => p.unitId === u.id);
      const taskEl = card.querySelector(".task") as HTMLElement;
      taskEl.textContent = cmd.task;
      taskEl.title = `${cmd.task} — ${cmd.action}`;
      const targetEl = card.querySelector(".target") as HTMLElement;
      targetEl.textContent = trialPlan
        ? `→ ${trialPlan.corridorId === "narrow" ? "Narrow Cut" : "Outer Passage"} · ${Math.round(trialPlan.progress * 100)}%`
        : cmd.target !== "—" ? `→ ${cmd.target}` : "";
      const statusEl = card.querySelector(".status-chip") as HTMLElement;
      statusEl.textContent = trialPlan ? trialPlan.state.replace(/\b\w/g, (x) => x.toUpperCase()) : STATUS_LABELS[cmd.status];
      statusEl.className = `status-chip st-${cmd.status}`;
      const hullBar = card.querySelector(".bar.hull") as HTMLElement;
      const hullFill = hullBar.querySelector("i") as HTMLElement;
      const hullPct = (u.hull / spec(u.role).hull) * 100;
      hullFill.style.transform = `scaleX(${Math.max(0, hullPct) / 100})`;
      hullBar.classList.toggle("low", hullPct < 55 && hullPct >= 28);
      hullBar.classList.toggle("critical", hullPct < 28);
      const battBar = card.querySelector(".bar.batt") as HTMLElement;
      const battFill = battBar.querySelector("i") as HTMLElement;
      battFill.style.transform = `scaleX(${Math.max(0, u.battery) / 100})`;
      battBar.classList.toggle("low", u.battery < 30);
      // core chip
      let chip = card.querySelector(".core-chip");
      if (u.hasCore && !chip) {
        const c = document.createElement("span");
        c.className = "core-chip";
        c.textContent = "CORE";
        card.querySelector(".row1")!.appendChild(c);
      } else if (!u.hasCore && chip) chip.remove();
    }

    // NEREUS live command panel
    const cState = commanderState(sim, nereus);
    this.els.nereusState.textContent = COMMANDER_STATE_LABELS[cState];
    this.els.nereusState.className = `state-pill cs-${cState}`;
    this.els.nereusObjective.textContent = sim.objectiveText();
    this.els.nereusDoctrine.textContent = DOCTRINE_LABELS[sim.doctrine];
    this.els.nereusOrder.textContent = this.orderStatusText(sim, now);
    this.els.crownStrip.classList.toggle("hidden",!sim.crown);if(sim.crown){const phases=["insertion","canyon","network","minefield","defense","core","extraction"];this.els.crownStrip.innerHTML=phases.map(p=>`<span class="${sim.crown!.phase===p?"active":sim.crown!.completed.has(p as never)?"done":""}">${p}</span>`).join("");}
    this.updateTrialModule(sim, nereus);
    this.updateThreatModule(sim,nereus);
    this.updateDefenseModule(sim,nereus);
    this.updateNetworkModule(sim);
    this.updateLogisticsModule(sim);
    const contacts=sim.contacts.size+(sim.minefield?.contacts.size??0)+(sim.echoRidge?.contacts.size??0);const damaged=sim.units.some(u=>u.hull<spec(u.role).hull||u.battery<70);this.updateTutorial({playing:true,selectedUnit:!!selectedId,hasAssignments:nereus.commandLog.length>0,hasContacts:contacts>0,obstacleRelevant:!!sim.canyonTrial,networkRelevant:!!sim.silentDivideState||!!sim.crown&&sim.crown.phase==="network",defenseRelevant:!!sim.echoRidge,logisticsRelevant:damaged||sim.logisticsEvents.length>0,manualActive:!!sim.manualOwnerId});
    // latest significant plan change (actual assignment log, not decorative)
    const lastDecision = nereus.decisions[nereus.decisions.length - 1];
    this.els.nereusPlan.textContent = lastDecision ? lastDecision.text : "Forming the fleet.";
    this.els.nereusPlan.title = this.els.nereusPlan.textContent;

    // command timeline (rebuilt only when the log changes)
    const log = nereus.commandLog;
    const lastEntry = log[log.length - 1];
    const tlKey = `${log.length}|${lastEntry?.time ?? -1}`;
    if (tlKey !== this.lastTimelineKey) {
      this.lastTimelineKey = tlKey;
      const entries = log.slice(-14).reverse();
      this.els.timeline.innerHTML = entries
        .map((c) => {
          const data =
            (c.unitId ? ` data-unit="${c.unitId}"` : "") +
            (c.pos ? ` data-pos="${c.pos.x},${c.pos.y},${c.pos.z}"` : "");
          return `<div class="tl-entry tl-${c.kind}"${data}><b>${fmtTime(c.time)}</b> ${escapeHtml(c.text)}</div>`;
        })
        .join("");
    }

    // order button execution state + completion/transition tracking
    const fo = sim.fleetOrder;
    for (const [k, b] of this.els.orderBtns) {
      b.classList.toggle("executing", fo?.kind === k);
    }
    if (this.prevOrderKind && !fo) {
      if (!this.orderClearedByUser) {
        this.orderFlash = { text: `${ORDER_LABELS[this.prevOrderKind]} — completed`, until: now + 6 };
      }
      this.orderClearedByUser = false;
    }
    this.prevOrderKind = fo?.kind ?? null;

    // unit detail: command readout + live controller instrumentation
    const u = selectedId ? sim.unit(selectedId) : null;
    if (u) {
      this.els.detail.classList.remove("hidden");
      const cmd = unitCommand(u, sim);
      this.els.detail.innerHTML = this.detailHtml(u, cmd);
      const pingBtn = this.els.detail.querySelector('[data-act="ping"]');
      pingBtn?.addEventListener("click", () => this.cb.onPing());
      const jamBtn = this.els.detail.querySelector('[data-act="jam"]');
      jamBtn?.addEventListener("click", () => this.cb.onJam());
      this.els.detail.querySelector('[data-act="return"]')?.addEventListener("click",()=>this.cb.onManualMode(false));
    } else {
      this.els.detail.classList.add("hidden");
    }

    // order refusal toast
    if (sim.orderRefusal && sim.now < sim.orderRefusal.until) {
      if (!this.els.toast) {
        this.els.toast = document.createElement("div");
        this.els.toast.className = "toast";
        this.root.appendChild(this.els.toast);
      }
      this.els.toast.textContent = `Cannot comply: ${sim.orderRefusal.text}`;
    } else if (this.els.toast) {
      this.els.toast.remove();
      this.els.toast = null;
    }

    // minimap at lower rate
    if (now - this.lastMinimap > 0.25) {
      this.lastMinimap = now;
      this.drawMinimap(sim, selectedId);
    }
  }
  updatePerformance(show:boolean,fps:number,draws:number,triangles:number){this.els.performance.classList.toggle("hidden",!show);this.els.performance.textContent=`FPS ${Math.round(fps)} · Draws ${draws} · Triangles ${Math.round(triangles/1000)}k`;}

  /**
   * Selected-unit readout: NEREUS command (assignment) on top, movement
   * controller response (actual applied values) below.
   */
  private detailHtml(u: Unit, cmd: UnitCommand): string {
    const s = spec(u.role);
    const pingReady = u.state === "active";
    const jamReady = u.role === "ECHO" && u.state === "active";
    const deg = (r: number) => ((r * 180) / Math.PI + 360) % 360;
    const hdgNow = deg(u.heading);
    const hdgCmd = u.cmdHeading !== null ? deg(u.cmdHeading) : null;
    // steering indicator from the actual applied yaw rate
    const turnDegS = (u.turnCmd * 180) / Math.PI;
    const steer =
      u.state !== "active"
        ? `<span class="steer-hold">—</span>`
        : Math.abs(turnDegS) < 1.5
          ? `<span class="steer-hold">◆ amidships</span>`
          : turnDegS > 0
            ? `<span class="steer-dir">▶ starboard ${Math.abs(turnDegS).toFixed(0)}°/s</span>`
            : `<span class="steer-dir">◀ port ${Math.abs(turnDegS).toFixed(0)}°/s</span>`;
    // vertical: actual applied depth rate
    const vert =
      u.state !== "active"
        ? "—"
        : u.verticalSpeed > 0.3
          ? `▼ descending ${u.verticalSpeed.toFixed(1)} m/s`
          : u.verticalSpeed < -0.3
            ? `▲ ascending ${Math.abs(u.verticalSpeed).toFixed(1)} m/s`
            : "◆ holding depth";
    const speedPct = Math.min(1, u.speed / s.maxSpeed);
    const cmdPct = Math.min(1, u.targetSpeed / s.maxSpeed);
    const capPct = Math.min(1, orderedSpeed(u) / s.maxSpeed);
    return `
      <div class="title"><span class="name">${u.callsign}</span><span class="role-desc">${ROLE_DESCS[u.role]}</span></div>
      <div class="ownership ${u.control.mode}">${u.control.mode === "manual" ? "PLAYER CONTROLLED" : u.control.mode === "recovering" ? "RETURNING TO NEREUS" : "NEREUS CONTROLLED"}</div>
      <div class="cmd-block">
        <div class="blk-label">NEREUS command</div>
        <div class="stats">
          <span>Task</span><b>${escapeHtml(cmd.task)}</b>
          <span>Target</span><b>${escapeHtml(cmd.target)}</b>
          <span>Status</span><b class="st-${cmd.status}">${STATUS_LABELS[cmd.status]}</b>
          <span>Action</span><b>${escapeHtml(cmd.action)}</b>
          <span>Throttle</span><b>${speedOrderLabel(u.speedOrder)}</b>
        </div>
      </div>
      <div class="cmd-block">
        <div class="blk-label">Controller response</div>
        <div class="instruments">
          <div class="dial-wrap">
            <svg class="dial" viewBox="0 0 60 60" aria-label="Heading: current vs commanded">
              <circle cx="30" cy="30" r="26" class="dial-face"/>
              <path d="M30 6 v5 M30 49 v5 M6 30 h5 M49 30 h5" class="dial-ticks"/>
              ${hdgCmd !== null ? `<line x1="30" y1="30" x2="30" y2="11" class="needle-cmd" transform="rotate(${hdgCmd.toFixed(1)} 30 30)"/>` : ""}
              <line x1="30" y1="34" x2="30" y2="9" class="needle-now" transform="rotate(${hdgNow.toFixed(1)} 30 30)"/>
              <circle cx="30" cy="30" r="2" class="dial-hub"/>
            </svg>
            <div class="dial-legend">HDG ${Math.round(hdgNow)}°${hdgCmd !== null ? `<br><span class="cmd-text">CMD ${Math.round(hdgCmd)}°</span>` : `<br><span class="cmd-text">no steering cmd</span>`}</div>
          </div>
          <div class="gauge-col">
            <div class="gauge-row"><span>SPD</span>
              <div class="gauge"><i class="fill" style="transform:scaleX(${speedPct.toFixed(3)})"></i><i class="marker" style="left:${(cmdPct * 100).toFixed(1)}%"></i><i class="cap" style="left:${(capPct * 100).toFixed(1)}%"></i></div>
              <b>${u.speed.toFixed(1)}</b>
            </div>
            <div class="gauge-legend">cmd ${u.targetSpeed.toFixed(1)} m/s · limit ${orderedSpeed(u).toFixed(0)} m/s (${speedOrderLabel(u.speedOrder).toLowerCase()})</div>
            <div class="inst-row"><span>Steering</span>${steer}</div>
            <div class="inst-row"><span>Depth</span><b>${Math.round(u.depth)} m${u.cmdDepth !== null ? ` → ${Math.round(u.cmdDepth)} m` : ""}</b></div>
            <div class="inst-row"><span>Vertical</span><b>${vert}</b></div>
          </div>
        </div>
      </div>
      <div class="stats">
        <span>Status</span><b>${u.state}${u.hasCore ? " · carrying core" : ""}</b>
        <span>Hull</span><b>${Math.round(u.hull)} / ${s.hull}</b>
        <span>Battery</span><b>${Math.round(u.battery)}%</b>
        ${u.role === "LANCER" ? `<span>Torpedoes</span><b>${u.torpedoes}</b>` : ""}
        ${u.role === "MENDER" ? `<span>Repair kits</span><b>${u.repairKits}</b>` : ""}
        ${u.interactProgress > 0.01 ? `<span>Progress</span><b>${Math.round(u.interactProgress * 100)}%</b>` : ""}
      </div>
      <div class="actions">
        <button data-act="ping" ${pingReady ? "" : "disabled"} title="Active sonar: reveal nearby contacts, but broadcast your position">Ping</button>
        <button data-act="jam" ${jamReady ? "" : "disabled"} title="Echo only: jam hostile sensors in the area">Jam</button>
      </div>
      ${u.control.mode === "manual" ? `<div class="manual-helm"><div class="blk-label">Manual helm</div><div class="stats"><span>Requested heading</span><b>${Math.round(((u.control.command.heading*180/Math.PI)+360)%360)}°</b><span>Requested depth</span><b>${Math.round(u.control.command.depth)} m</b><span>Requested speed</span><b>${u.control.command.throttle.toFixed(1)} m/s</b><span>Noise</span><b>${Math.round(u.noise)}</b><span>Safety</span><b>${u.control.correction ?? "Clear"}</b><span>Role action</span><b>${u.role === "ATLAS" ? "Command Pulse" : u.role === "GHOST" ? "Silent Observation" : u.role === "LANCER" ? "Prepare Defensive Action" : u.role === "ECHO" ? "Focused Scan" : "Request Repair"}</b></div><p>Manual helm bindings are configurable in Settings → Key bindings.</p><button data-act="return">Return to NEREUS</button></div>` : ""}`;
  }

  private updateTrialModule(sim: Simulation, nereus: Nereus) {
    const trial = sim.canyonTrial;
    const decision = nereus.trialDecision;
    const controls = this.els.trialModule.querySelector(".trial-controls") as HTMLElement;
    this.els.trialStart.classList.toggle("hidden", !!trial);
    controls.classList.toggle("hidden", !trial);
    if (!trial) return;
    (this.els.trialModule.querySelector('[data-trial="priority"]') as HTMLSelectElement).value = trial.priority;
    (this.els.trialModule.querySelector('[data-trial="coordination"]') as HTMLSelectElement).value = trial.coordination;
    (this.els.trialModule.querySelector('[data-trial="clearance"]') as HTMLInputElement).value = String(trial.clearanceMargin);
    (this.els.trialModule.querySelector('[data-trial="speed"]') as HTMLInputElement).value = String(trial.speedLimit);
    (this.els.trialModule.querySelector('[data-out="clearance"]') as HTMLOutputElement).value = `${trial.clearanceMargin} m`;
    (this.els.trialModule.querySelector('[data-out="speed"]') as HTMLOutputElement).value = `${trial.speedLimit} m/s`;
    this.els.trialModule.classList.toggle("complete", trial.status === "complete");
    const state = this.els.trialModule.querySelector(".trial-state b") as HTMLElement;
    state.textContent = trial.status === "complete" ? "Canyon Passage · Complete" : trial.held ? "Canyon Passage · Fleet held" : "Canyon Passage · Executing";
    const obstruction = this.els.trialModule.querySelector('[data-trial-act="obstruct"]') as HTMLButtonElement;
    obstruction.disabled = trial.obstructionIntroduced;
    if (!decision) {
      this.els.trialPlan.textContent = "NEREUS is collecting obstacle observations.";
      this.els.trialRoutes.innerHTML = "";
      return;
    }
    this.els.trialPlan.innerHTML = `<span>PLAN R${decision.revision}</span><p>${escapeHtml(decision.explanation)}</p>`;
    this.els.trialRoutes.innerHTML = decision.assessments.map((route) => {
      const usable = route.usableBy.length ? route.usableBy.join(" · ") : "None";
      return `<div class="route-card route-${route.status}">
        <div><b>${route.corridorId === "narrow" ? "Narrow Cut" : "Outer Passage"}</b><span>${route.status}</span></div>
        <dl><dt>Distance</dt><dd>${Math.round(route.distance)} m</dd><dt>Safe hulls</dt><dd>${usable}</dd><dt>Assessment</dt><dd>${escapeHtml(route.reason)}</dd></dl>
      </div>`;
    }).join("");
  }

  private updateThreatModule(sim:Simulation,nereus:Nereus){const state=sim.minefield,controls=this.els.threatModule.querySelector(".threat-controls") as HTMLElement,start=this.els.threatModule.querySelector(".minefield-start") as HTMLElement;start.classList.toggle("hidden",!!state);controls.classList.toggle("hidden",!state);if(!state)return;const counts={unknown:0,probable:0,confirmed:0,decoy:0};for(const c of state.contacts.values()){if(c.classification==="unknown"||c.classification==="possibleHazard"||c.classification==="lost")counts.unknown++;else if(c.classification==="probableMine")counts.probable++;else if(c.classification==="mine")counts.confirmed++;else if(c.classification==="decoy")counts.decoy++;}(this.els.threatModule.querySelector("[data-threat-status]") as HTMLElement).textContent=`${state.status} · ${counts.unknown} unknown · ${counts.probable} probable · ${counts.confirmed} confirmed`;
    const d=nereus.minefieldDecision;(this.els.threatModule.querySelector(".threat-summary") as HTMLElement).innerHTML=d?`<div class="trial-plan"><span>THREAT PLAN R${d.revision}</span><p>${escapeHtml(d.explanation)}</p></div>${d.assessments.map(a=>`<div class="route-card route-${a.status==="blocked"?"blocked":a.status==="valid"?"available":"unverified"}"><div><b>${a.name}</b><span>${a.status}</span></div><dl><dt>Distance</dt><dd>${Math.round(a.distance)} m</dd><dt>Contacts</dt><dd>${a.affectingContacts.join(" · ")||"None"}</dd><dt>Transit</dt><dd>${Math.round(a.transitTime)} s</dd><dt>Reason</dt><dd>${escapeHtml(a.reason)}</dd></dl></div>`).join("")}`:"Scanning not started.";
    this.drawThreatMap(sim);
  }

  private drawThreatMap(sim:Simulation){const canvas=this.els.threatModule.querySelector(".threat-map") as HTMLCanvasElement,g=canvas.getContext("2d")!,w=canvas.width,h=canvas.height;g.fillStyle="#07151d";g.fillRect(0,0,w,h);const map=(p:Vec3):[number,number]=>[(p.x+1400)/2800*w,(p.z+1400)/2800*h];for(const c of sim.minefield?.contacts.values()??[]){const[x,y]=map(c.estimate);g.strokeStyle=c.classification==="decoy"?"#6fe8a0":c.classification==="mine"?"#ff5340":"#ffb347";g.setLineDash(c.classification==="mine"?[]:[4,3]);g.beginPath();g.arc(x,y,Math.max(4,c.uncertainty/14),0,Math.PI*2);g.stroke();}g.setLineDash([]);for(const u of sim.units){const[x,y]=map(u.pos);g.fillStyle="#7fd8e8";g.beginPath();g.arc(x,y,3,0,Math.PI*2);g.fill();}}

  private updateDefenseModule(sim:Simulation,nereus:Nereus){const state=sim.echoRidge,controls=this.els.defenseModule.querySelector(".defense-controls") as HTMLElement,start=this.els.defenseModule.querySelector(".defense-start") as HTMLElement;start.classList.toggle("hidden",!!state);controls.classList.toggle("hidden",!state);if(!state)return;(this.els.defenseModule.querySelector("[data-defense-alert]") as HTMLElement).textContent=state.alert.toUpperCase();const contacts=[...state.contacts.values()],hostile=contacts.filter(c=>["hostile","tracking","engaging","suspectedHostile"].includes(c.classification));(this.els.defenseModule.querySelector(".defense-plan") as HTMLElement).innerHTML=`<div class="trial-plan"><span>DEFENSE PLAN R${state.revision}</span><p>${escapeHtml(nereus.planSummary)}</p></div><div class="stats"><span>Mobile contacts</span><b>${contacts.length}</b><span>Hostile tracks</span><b>${hostile.length}</b><span>Countermeasures</span><b>${state.countermeasures}</b><span>Interceptors launched</span><b>${state.interceptorsLaunched}</b><span>Package</span><b>${state.packageState}</b></div>`;}

  private updateNetworkModule(sim:Simulation){const net=sim.network,summary=this.els.networkModule.querySelector(".network-summary") as HTMLElement;const counts={linked:0,degraded:0,disconnected:0,reconnecting:0,synchronizing:0};for(const l of net.links.values())counts[l.state]++;summary.innerHTML=`<div class="trial-plan"><span>TOPOLOGY R${net.topologyRevision}</span><p>${counts.linked} linked · ${counts.degraded} degraded · ${counts.disconnected} disconnected · ${net.relays.filter(r=>r.active).length} relays</p></div>${[...net.links.values()].map(l=>`<div class="network-row state-${l.state}"><b>${sim.unit(l.unitId)?.callsign??l.unitId}</b><span>${l.state}</span><small>${l.route.join(" → ")||"No path"} · ${(sim.now-l.telemetryAt).toFixed(1)}s old · ${l.latency.toFixed(2)}s</small></div>`).join("")}`;const messages=this.els.networkModule.querySelector(".network-messages") as HTMLElement;messages.innerHTML=net.messages.slice(-8).reverse().map(m=>`<div class="tl-entry"><b>${m.kind}</b> ${m.sender} → ${m.receiver} · ${m.state}</div>`).join("");this.drawNetworkMap(sim);}
  private updateLogisticsModule(sim:Simulation){(this.els.logisticsModule.querySelector(".logistics-summary")as HTMLElement).innerHTML=sim.units.map(u=>`<div class="network-row"><b>${u.callsign}</b><span>${Math.round(u.logistics.energy)}/${u.logistics.energyCapacity}</span><small>kits ${u.logistics.repairKits} · interceptors ${u.logistics.interceptors} · decoys ${u.logistics.decoys} · relays ${u.logistics.relays} · ${u.state}</small></div>`).join("")+`<div class="trial-plan"><span>RESERVE</span><p>${sim.logisticsPolicy.minimumReserve}% emergency energy · ${sim.logisticsPolicy.conservation}</p></div>`;}
  private drawNetworkMap(sim:Simulation){const c=this.els.networkModule.querySelector(".network-map") as HTMLCanvasElement,g=c.getContext("2d")!,w=c.width,h=c.height,map=(p:Vec3):[number,number]=>[(p.x+1400)/2800*w,(p.z+1400)/2800*h];g.fillStyle="#07151d";g.fillRect(0,0,w,h);for(const l of sim.network.links.values()){const[x,y]=map(l.lastKnownPos);g.strokeStyle=l.state==="linked"?"#6fe8a0":l.state==="degraded"?"#ffb347":"#ff5340";g.beginPath();g.arc(x,y,4+l.uncertainty/18,0,Math.PI*2);g.stroke();}for(const r of sim.network.relays.filter(x=>x.active)){const[x,y]=map(r.pos);g.fillStyle="#7fd8e8";g.fillRect(x-3,y-3,6,6);}}

  private buildMinimapBackground(sim: Simulation) {
    const size = 216;
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    const img = g.createImageData(size, size);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px / size - 0.5) * WORLD.HALF * 2;
        const z = (py / size - 0.5) * WORLD.HALF * 2;
        const d = sim.mission.terrain.depthAt(x, z);
        const t = Math.min(1, d / 300);
        // shallow = teal, deep = dark navy
        const r = 10 + (1 - t) * 30;
        const gg = 22 + (1 - t) * 44;
        const b = 34 + (1 - t) * 46;
        const i = (py * size + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = gg;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.mmBg = c;
  }

  private drawMinimap(sim: Simulation, selectedId: string | null) {
    if (!this.mmBg) return;
    const canvas = this.els.minimap;
    const g = canvas.getContext("2d")!;
    const S = canvas.width; // 432 device px
    g.drawImage(this.mmBg, 0, 0, S, S);
    const toMap = (x: number, z: number): [number, number] => [
      ((x / (WORLD.HALF * 2)) + 0.5) * S,
      ((z / (WORLD.HALF * 2)) + 0.5) * S
    ];

    // objectives
    for (const o of sim.objectives) {
      const [x, y] = toMap(o.pos.x, o.pos.z);
      if (o.kind === "extraction") {
        g.strokeStyle = "#6fe8a0";
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 10, 0, Math.PI * 2);
        g.stroke();
      } else if (o.kind === "facility") {
        if (!sim.facilityRevealed) continue;
        g.fillStyle = "#ffb347";
        g.fillRect(x - 5, y - 5, 10, 10);
      } else {
        if (o.done) continue;
        g.fillStyle = "#7fd8e8";
        g.beginPath();
        g.moveTo(x, y - 6);
        g.lineTo(x + 5, y);
        g.lineTo(x, y + 6);
        g.lineTo(x - 5, y);
        g.closePath();
        g.fill();
      }
    }

    // dropped core
    if (sim.coreState === "dropped" && sim.corePos) {
      const [x, y] = toMap(sim.corePos.x, sim.corePos.z);
      g.fillStyle = "#ffb347";
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
    }

    // contacts
    for (const c of sim.contacts.values()) {
      const [x, y] = toMap(c.pos.x, c.pos.z);
      if (c.kind === "securityNode") {
        const node = sim.nodes.find((n) => n.id === c.refId);
        const col =
          node?.state === "alert" ? "#ff5340" : node?.state === "disabled" || node?.state === "destroyed" ? "#4a5a62" : "#ffb347";
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(x, y - 6);
        g.lineTo(x + 6, y + 5);
        g.lineTo(x - 6, y + 5);
        g.closePath();
        g.fill();
        if (!c.confirmed) {
          g.strokeStyle = "rgba(255,179,71,0.4)";
          g.beginPath();
          g.arc(x, y, c.uncertainty / (WORLD.HALF * 2) * S, 0, Math.PI * 2);
          g.stroke();
        }
      } else if (c.kind === "mine") {
        g.strokeStyle = "#ff5340";
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(x - 3, y - 3);
        g.lineTo(x + 3, y + 3);
        g.moveTo(x + 3, y - 3);
        g.lineTo(x - 3, y + 3);
        g.stroke();
      }
    }

    // units
    for (const u of sim.units) {
      const [x, y] = toMap(u.pos.x, u.pos.z);
      const destroyed = u.state === "destroyed";
      const col = destroyed ? "#5a3a34" : u.id === selectedId ? "#ffffff" : "#7fd8e8";
      g.fillStyle = col;
      g.beginPath();
      g.arc(x, y, u.id === selectedId ? 5 : 3.6, 0, Math.PI * 2);
      g.fill();
      if (!destroyed) {
        g.strokeStyle = col;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.sin(u.heading) * 9, y + Math.cos(u.heading) * 9);
        g.stroke();
        if (u.hasCore) {
          g.fillStyle = "#ffb347";
          g.fillRect(x - 2, y - 12, 5, 5);
        }
      }
    }

    // order target
    if (sim.fleetOrder?.pos) {
      const [x, y] = toMap(sim.fleetOrder.pos.x, sim.fleetOrder.pos.z);
      g.strokeStyle = "#eafcff";
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(x, y, 8, 0, Math.PI * 2);
      g.moveTo(x - 12, y);
      g.lineTo(x - 4, y);
      g.moveTo(x + 4, y);
      g.lineTo(x + 12, y);
      g.stroke();
    }
  }

  destroy() {
    this.controlsTrap?.deactivate({restore:false});this.controlsTrap=null;
    this.root.innerHTML = "";
    this.root.classList.add("hidden");
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
