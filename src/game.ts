import { Nereus } from "./ai/nereus";
import { AudioSystem } from "./audio/audio";
import { CommandController } from "./command/controller";
import { CommandContext } from "./command/parser";
import { SIM } from "./config";
import { CameraMode } from "./render/cameras";
import { Quality, WorldView } from "./render/worldview";
import { Simulation } from "./sim/simulation";
import { spec as specRole } from "./sim/units";
import { hashSeed } from "./rng";
import { generateAbyssalCrownScenario, generateCanyonPassageTrial, generateEchoRidgeScenario, generateSilentDivideScenario, generateSilentMinefieldTrial } from "./world/mission";
import { Doctrine, FleetOrderKind, GameSpeed, SimEvent, Vec3, vec3 } from "./types";
import { ManualControlToken } from "./types";
import { actionFor } from "./input/actions";
import { GamepadInput } from "./input/gamepad";
import { Hud } from "./ui/hud";
import { Menus, Settings } from "./ui/menus";
import { CampaignState, hydrateSimulation, memoryRepository, newCampaign, OperationId, serviceFleet, settleCampaign } from "./logistics/campaign";
import { loadout } from "./logistics/domain";

type GameState = "menu" | "briefing" | "playing" | "debrief";

export class Game {
  private canvas: HTMLCanvasElement;
  private menus: Menus;
  private hud: Hud;
  private audio = new AudioSystem();

  private state: GameState = "menu";
  private sim: Simulation | null = null;
  private nereus: Nereus | null = null;
  private view: WorldView | null = null;

  private speed: GameSpeed = 1;
  private pausedByMenu = false;
  private selectedId: string | null = null;
  private camMode: CameraMode = "cinematic";
  private accumulator = 0;
  private lastT = 0;
  private elapsed = 0;
  private outcomeAt = -1;
  private debriefShown = false;
  private statsLogged = false;
  private frameCount = 0;
  private fpsWindowStart = 0;
  private fpsSampleAt=0;
  private fpsSampleFrames=0;
  private measuredFps=0;
  private pendingShot: { name: string; at: number } | null = null;
  private pendingLayoutAudit: { name: string; at: number } | null = null;
  private visualDebug = new URLSearchParams(location.search).get("debugPresentation") === "1";
  private commandController = new CommandController();
  private campaignRepo=memoryRepository();
  private campaign:CampaignState|null=null;
  private campaignOperation:OperationId|null=null;
  private campaignSortieId:string|null=null;
  private pendingCampaignOperation:OperationId|null=null;
  private storageRecovery:{campaign:CampaignState;raw?:string;id?:string}|null=null;

  private eventFocus: Vec3 | null = null;
  private eventFocusAt = -99;

  // pointer state
  private pointerDown = false;
  private pointerMoved = false;
  private lastPX = 0;
  private lastPY = 0;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private manualToken: ManualControlToken | null = null;
  private manualKeys = new Set<string>();
  private gamepad=new GamepadInput();
  private gamepadHeld=new Set<string>();
  private clearManualInput(){this.manualKeys.clear();this.gamepadHeld.clear();}

  constructor(canvas: HTMLCanvasElement, hudRoot: HTMLElement, menusRoot: HTMLElement) {
    this.canvas = canvas;
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));

    this.hud = new Hud(hudRoot, {
      onSelectUnit: (id) => {
        this.selectedId = id;
        if(id)this.hud.tutorialEvent("unit-selected");
        if (id && this.camMode === "cinematic") this.setCameraMode("follow");
      },
      onDoctrine: (d) => this.sim?.setDoctrine(d),
      onOrder: (kind) => this.handleOrderButton(kind),
      onClearOrder: () => {
        this.sim?.clearOrder();
        this.hud.setArmedOrder(null);
      },
      onSpeed: (s) => this.setSpeed(s),
      onCameraMode: (m) => this.setCameraMode(m),
      onPing: () => {
        if (this.selectedId && this.sim) {
          this.sim.ping(this.selectedId);
        }
      },
      onJam: () => {
        if (this.selectedId && this.sim) this.sim.jam(this.selectedId);
      },
      onOpenMenu: () => this.openPauseMenu(),
      onToggleMute: () => this.toggleMute(),
      onFocusPoint: (pos) => {
        // timeline click: look at the location (tactical pans, cinematic cuts)
        if (this.camMode === "tactical" && this.view) {
          this.view.rig.tacticalJumpTo(pos);
        } else {
          this.eventFocus = pos;
          this.eventFocusAt = this.sim?.now ?? 0;
        }
      },
      onToggleAIOrders: (on) => this.view?.setAIOrdersVisible(on),
      onStartObstacleTrial: () => this.startObstacleTrial(),
      onTrialSettings: (settings) => this.sim?.updateTrialSettings(settings),
      onTrialObstruction: () => {
        if (this.sim?.introduceTrialObstruction()) this.setSpeed(1);
      },
      onResetTrial: () => this.startObstacleTrial(),
      onStartMinefield: (seed) => { this.menus.seed=seed; this.startMinefieldTrial(); },
      onMinefieldSettings: (settings) => this.sim?.updateMinefieldSettings(settings),
      onReleaseDriftingMine: () => { if(this.sim?.releaseDriftingMine()) this.setSpeed(1); },
      onControlCenterWidth: (width) => {
        this.canvas.style.left = `${width}px`;
        this.canvas.style.width = `calc(100% - ${width}px)`;
        requestAnimationFrame(() => this.view?.resize());
      },
      onLabelMode: (mode) => this.view?.setLabelMode(mode)
      ,onManualMode: (enabled) => enabled ? this.takeManualControl() : this.returnToNereus()
      ,onFleetDirectives: (settings) => {this.sim?.updateFleetDirectives(settings);this.hud.tutorialEvent("directive-changed");}
      ,onSpecialCommand: (command) => this.executeSpecialCommand(command)
      ,onStartHandoffTrial: () => this.startHandoffTrial()
      ,onStartDefense: () => this.startSimulation("balanced",false,false,true)
      ,onDefenseSettings: (settings) => this.sim?.updateDefenseSettings(settings as never)
      ,onReinforcement: () => this.sim?.introduceReinforcement()
      ,onStartDivide: () => this.startSimulation("balanced",false,false,false,true)
      ,onNetworkPolicy: (policy,posture) => this.sim?.updateNetworkPolicy(policy,posture)
      ,onDeployRelay: () => {if(this.sim&&this.selectedId)this.sim.deployRelay(this.selectedId);}
      ,onActivateJammer: () => this.sim?.activateUnknownJammer()
      ,onConsoleCommand: (input) => this.submitConsoleCommand(input)
      ,onConsoleConfirm: () => this.executeConsoleCommand(true)
      ,onConsoleCancel: () => {this.commandController.cancel();this.refreshConsole();}
      ,onStartCrown: () => this.startSimulation("balanced",false,false,false,false,true)
      ,onLogisticsPolicy: (settings) => this.sim?.updateLogisticsPolicy(settings)
      ,onTouchAction:(action)=>this.performInputAction(action)
      ,onTouchHold:(action,active)=>{if(active)this.manualKeys.add(action);else this.manualKeys.delete(action);}
    });

    this.menus = new Menus(menusRoot, {
      onStart: (seed, difficulty) => {
        this.menus.seed = seed;
        this.menus.difficulty = difficulty;
        this.menus.showBriefing();
        this.state = "briefing";
      },
      onDeploy: (doctrine,prep) => {if(this.pendingCampaignOperation)this.launchCampaignOperation(this.pendingCampaignOperation,doctrine,prep);else{this.startMission(doctrine);if(this.sim){this.sim.updateLogisticsPolicy({minimumReserve:prep.reserve,authorizeScarce:prep.authorize});for(const u of this.sim.units){u.logistics=loadout({role:u.role,emphasis:prep.emphasis});u.battery=100;}}}},
      onResume: () => this.closePauseMenu(),
      onRestart: (sameSeed) => this.restart(sameSeed),
      onQuitToMenu: () => this.quitToMenu(),
      onQuality: (q) => this.view?.setQuality(q),
      onVolume: (kind, v) => {
        this.audio.volumes[kind] = v;
        this.audio.applyVolumes();
      },
      onReducedMotion: (on) => {
        this.menus.settings.reducedMotion = on;
      },
      onCustomGraphics:(settings)=>this.view?.setCustomQuality(settings),
      onNewCampaign:()=>{this.campaign=newCampaign();const saved=this.campaignRepo.saveSafe(this.campaign);if(saved.ok)this.menus.showCampaign(this.campaign);else this.showStorageFailure(saved.message,saved.raw,this.campaign);},
      onContinueCampaign:(id)=>{if(id==="latest"){const list=this.campaignRepo.listSafe();if(list.corrupt.length){const bad=list.corrupt[0];this.storageRecovery={campaign:newCampaign(),raw:bad.raw,id:bad.id};this.menus.showStorageRecovery({title:"Damaged campaign save",message:bad.message,raw:bad.raw,canDelete:true});return;}const c=list.campaigns.at(-1)??null;if(c){this.campaign=c;this.menus.showCampaign(c);}else this.menus.showStart();}else{const loaded=this.campaignRepo.loadSafe(id);if(loaded.ok){this.campaign=loaded.value;this.menus.showCampaign(loaded.value);}else{this.storageRecovery={campaign:newCampaign(),raw:loaded.raw,id};this.menus.showStorageRecovery({title:"Unable to load campaign",message:loaded.message,raw:loaded.raw,canDelete:!!loaded.raw});}}},
      onCampaignOperation:(id)=>this.prepareCampaignOperation(id as OperationId)
      ,onServiceCampaign:()=>{if(this.campaign){serviceFleet(this.campaign,["MENDER","ATLAS","ECHO","LANCER","GHOST"]);const saved=this.campaignRepo.saveSafe(this.campaign);if(saved.ok)this.menus.showCampaign(this.campaign);else this.showStorageFailure(saved.message,saved.raw,this.campaign);}},
      onStorageRetry:()=>{if(!this.storageRecovery)return;const r=this.campaignRepo.saveSafe(this.storageRecovery.campaign);if(r.ok){this.campaign=r.value;this.storageRecovery=null;this.menus.showCampaign(r.value);}else this.menus.showStorageRecovery({title:"Save retry failed",message:r.message,raw:r.raw,canRetry:true});},
      onStorageExport:()=>{const raw=this.storageRecovery?.raw;if(!raw)return;const blob=new Blob([raw],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="abyss-command-recovery.json";a.click();URL.revokeObjectURL(url);},
      onStorageDelete:()=>{if(this.storageRecovery?.id)this.campaignRepo.deleteSafe(this.storageRecovery.id);this.storageRecovery=null;this.menus.showStart();}
    });

    this.bindInput();

    // dev harness: ?auto=SEED:difficulty:doctrine&fast=<simseconds>&speed=2&cam=tactical
    const params = new URLSearchParams(location.search);
    const auto = params.get("auto");
    if (params.get("trial") === "canyon") {
      this.menus.seed = params.get("seed") || "CANYON-PASSAGE";
      this.menus.difficulty = "normal";
      this.startObstacleTrial();
      const fast = Number(params.get("fast") ?? 0);
      if (fast > 0 && this.sim && this.nereus) {
        const steps = Math.min(fast, 900) * 60;
        for (let i = 0; i < steps; i++) {
          this.sim.step();
          this.nereus.update();
        }
      }
      const sp = Number(params.get("speed") ?? "");
      if (sp === 0 || sp === 1 || sp === 2) this.speed = sp as GameSpeed;
      const shotName = params.get("shot");
      this.pendingShot = shotName !== null ? { name: shotName || "canyon-trial", at: 5 } : null;
      const auditName = params.get("audit");
      this.pendingLayoutAudit = auditName ? { name: auditName, at: 5 } : null;
    } else if(params.get("trial")==="minefield"){
      this.menus.seed=params.get("seed")||"SILENT-MINEFIELD";this.menus.difficulty="normal";this.startMinefieldTrial();
      const fast=Number(params.get("fast")??0);if(fast>0&&this.sim&&this.nereus){for(let i=0;i<Math.min(fast,900)*60;i++){this.sim.step();this.nereus.update();}}
      const sp=Number(params.get("speed")??"");if(sp===0||sp===1||sp===2)this.speed=sp as GameSpeed;
    } else if(params.get("trial")==="defense"){
      this.menus.seed=params.get("seed")||"ECHO-RIDGE";this.menus.difficulty="normal";this.startSimulation("balanced",false,false,true);
      const fast=Number(params.get("fast")??0);if(fast>0&&this.sim&&this.nereus){for(let i=0;i<Math.min(fast,900)*60;i++){this.sim.step();this.nereus.update();}}
      const sp=Number(params.get("speed")??"");if(sp===0||sp===1||sp===2)this.speed=sp as GameSpeed;
    } else if(params.get("trial")==="divide"){
      this.menus.seed=params.get("seed")||"SILENT-DIVIDE";this.menus.difficulty="normal";this.startSimulation("balanced",false,false,false,true);
      const fast=Number(params.get("fast")??0);if(fast>0&&this.sim&&this.nereus){for(let i=0;i<Math.min(fast,900)*60;i++){this.sim.step();this.nereus.update();}}const sp=Number(params.get("speed")??"");if(sp===0||sp===1||sp===2)this.speed=sp as GameSpeed;
    } else if(params.get("mission")==="crown"){
      this.menus.seed=params.get("seed")||"ABYSSAL-CROWN";this.menus.difficulty=(params.get("difficulty") as "easy"|"normal"|"hard")||"normal";this.startSimulation("balanced",false,false,false,false,true);const fast=Number(params.get("fast")??0);if(fast>0&&this.sim&&this.nereus){for(let i=0;i<Math.min(fast,1800)*60&&!this.sim.outcome;i++){this.sim.step();this.nereus.update();}}const sp=Number(params.get("speed")??"");if(sp===0||sp===1||sp===2)this.speed=sp as GameSpeed;
    } else if (auto) {
      const [seed, diff, doc] = auto.split(":");
      this.menus.seed = seed || "ABYSS-7";
      this.menus.difficulty = (diff as "easy" | "normal" | "hard") || "normal";
      const doctrine = (doc as Doctrine) || "balanced";
      this.startMission(doctrine);
      const fast = Number(params.get("fast") ?? 0);
      if (fast > 0 && this.sim && this.nereus) {
        const steps = Math.min(fast, 900) * 60;
        for (let i = 0; i < steps && !this.sim.outcome; i++) {
          this.sim.step();
          this.nereus.update();
        }
      }
      const sp = Number(params.get("speed") ?? "");
      if (sp === 0 || sp === 1 || sp === 2) this.speed = sp as GameSpeed;
      const cam = params.get("cam");
      if (cam === "cinematic" || cam === "follow" || cam === "tactical") this.setCameraMode(cam);
      const shotName = params.get("shot");
      this.pendingShot = shotName !== null
        ? { name: shotName || `auto-${params.get("fast") ?? 0}-${params.get("cam") ?? "cinematic"}`, at: 5 }
        : null;
      const auditName = params.get("audit");
      this.pendingLayoutAudit = auditName ? { name: auditName, at: 5 } : null;
      if (params.get("hud") === "0") hudRoot.classList.add("hidden");
    } else {
      this.menus.showStart();
    }
    if(params.get("contextTest")==="1")setTimeout(()=>this.view?.testContextRecovery(),500);
    this.resolveReady();
  }

  whenReady() {
    return this.ready;
  }

  // ------------------------------------------------------------ lifecycle

  private startMission(doctrine: Doctrine) {
    this.startSimulation(doctrine, false);
  }

  private startObstacleTrial() {
    this.startSimulation(this.sim?.doctrine ?? this.menus.doctrine, true);
  }

  private startMinefieldTrial(){ this.startSimulation(this.sim?.doctrine??this.menus.doctrine,false,true); }
  private prepareCampaignOperation(id:OperationId){if(!this.campaign)return;this.pendingCampaignOperation=id;this.menus.seed=`${this.campaign.seed}-${id}`;this.menus.difficulty=this.campaign.difficulty;this.menus.showBriefing();this.state="briefing";}
  private launchCampaignOperation(id:OperationId,doctrine:Doctrine,prep:{emphasis:"balanced"|"endurance"|"mission";reserve:number;authorize:boolean}){if(!this.campaign)return;for(const vessel of this.campaign.fleet){vessel.loadout={role:vessel.role,emphasis:prep.emphasis};const prepared=loadout(vessel.loadout);vessel.inventory.energyCapacity=prepared.energyCapacity;vessel.inventory.repairCapacity=prepared.repairCapacity;vessel.inventory.interceptorCapacity=prepared.interceptorCapacity;vessel.inventory.decoyCapacity=prepared.decoyCapacity;vessel.inventory.relayCapacity=prepared.relayCapacity;vessel.inventory.energy=Math.min(vessel.inventory.energy,vessel.inventory.energyCapacity);vessel.inventory.repairKits=Math.min(vessel.inventory.repairKits,vessel.inventory.repairCapacity);vessel.inventory.interceptors=Math.min(vessel.inventory.interceptors,vessel.inventory.interceptorCapacity);vessel.inventory.decoys=Math.min(vessel.inventory.decoys,vessel.inventory.decoyCapacity);vessel.inventory.relays=Math.min(vessel.inventory.relays,vessel.inventory.relayCapacity);}this.campaignRepo.save(this.campaign);this.pendingCampaignOperation=null;this.campaignOperation=id;this.campaignSortieId=`${this.campaign.id}:${id}:${Date.now()}`;if(id==="canyon-passage")this.startSimulation(doctrine,true);else if(id==="silent-minefield")this.startSimulation(doctrine,false,true);else if(id==="silent-divide")this.startSimulation(doctrine,false,false,false,true);else if(id==="echo-ridge")this.startSimulation(doctrine,false,false,true);else if(id==="abyssal-crown")this.startSimulation(doctrine,false,false,false,false,true);else this.startMission(doctrine);if(this.sim){hydrateSimulation(this.campaign,this.sim);this.sim.updateLogisticsPolicy({minimumReserve:prep.reserve,authorizeScarce:prep.authorize});}}
  private settleCampaignSortie(){if(!this.campaign||!this.campaignOperation||!this.campaignSortieId||!this.sim)return;settleCampaign(this.campaign,{sortieId:this.campaignSortieId,operationId:this.campaignOperation,outcome:this.sim.outcome??"aborted",elapsedSeconds:this.sim.now,vessels:this.sim.units.map(u=>({role:u.role,state:u.state,hull:u.hull,subsystems:Object.fromEntries(Object.entries(u.subsystems).map(([k,v])=>[k,v.integrity])) as never,inventory:structuredClone(u.logistics)})),optionalObjectiveIds:this.sim.crown?Object.entries(this.sim.crown.optional).filter(([,v])=>v).map(([k])=>k):[],decisions:this.nereus?.decisions.slice(-8).map(d=>d.text)??[]});const saved=this.campaignRepo.saveSafe(this.campaign);if(saved.ok)this.campaignSortieId=null;else this.showStorageFailure(saved.message,saved.raw,this.campaign);}
  private showStorageFailure(message:string,raw:string|undefined,campaign:CampaignState){this.storageRecovery={campaign,raw,id:campaign.id};this.menus.showStorageRecovery({title:"Campaign save failed",message,raw,canRetry:true});}
  private startHandoffTrial(){this.startSimulation("balanced",true);this.sim?.emit("phaseChange","Command Handoff Trial: select Ghost, take manual control, navigate, then return to NEREUS.");}

  private startSimulation(doctrine: Doctrine, trial: boolean, minefield=false, defense=false,divide=false,crown=false) {
    this.manualToken=null;
    this.clearManualInput();
    this.commandController=new CommandController();
    this.teardownMission();
    const seed = hashSeed(this.menus.seed);
    this.sim = new Simulation(seed, this.menus.difficulty, crown?generateAbyssalCrownScenario(seed,this.menus.difficulty):divide?generateSilentDivideScenario(seed):defense?generateEchoRidgeScenario(seed):minefield?generateSilentMinefieldTrial(seed):trial ? generateCanyonPassageTrial(seed) : undefined);
    this.sim.setDoctrine(doctrine);
    this.nereus = new Nereus(this.sim);
    this.sim.onEvent = (e) => this.handleSimEvent(e);
    try {
      this.view = new WorldView(this.canvas, this.sim, this.menus.settings.quality);
      this.view.setAIOrdersVisible(this.hud.aiOrdersVisible);
      this.view.setLabelMode(this.hud.labelsVisible);
      this.view.setVisualDebug(this.visualDebug);
    } catch (err) {
      console.error("WebGL init failed", err);
      document.getElementById("webgl-error")!.classList.remove("hidden");
      return;
    }
    this.applySettings(this.menus.settings);
    this.hud.build(this.sim);
    this.hud.setManualMode(false,"");
    this.menus.hideAll();
    this.selectedId = null;
    this.camMode = trial||minefield||defense||divide||crown ? "tactical" : "cinematic";
    this.view.rig.setMode(this.camMode);
    this.speed = 1;
    this.pausedByMenu = false;
    this.accumulator = 0;
    this.elapsed = 0;
    this.frameCount = 0;
    this.fpsWindowStart = 0;
    this.outcomeAt = -1;
    this.debriefShown = false;
    this.statsLogged = false;
    this.eventFocus = null;
    this.state = "playing";
    if(crown){this.sim.emit("phaseChange","Operation Abyssal Crown deployed. NEREUS has mission command.");this.view.rig.tacticalJumpTo({x:-900,y:-130,z:0});}
    else if(divide){this.sim.emit("phaseChange","The Silent Divide started. NEREUS is establishing the fleet network.");this.view.rig.tacticalJumpTo({x:0,y:-125,z:100});}
    else if(defense){this.sim.emit("phaseChange","Ambush at Echo Ridge started. NEREUS has defensive command.");this.view.rig.tacticalJumpTo({x:0,y:-130,z:0});}
    else if (minefield){this.sim.emit("phaseChange","Silent Minefield trial started. NEREUS has threat-response command.");this.view.rig.tacticalJumpTo({x:0,y:-120,z:100});}
    else if (trial) {
      this.sim.emit("phaseChange", "Canyon Passage trial started. NEREUS has centralized obstacle-navigation command.");
      this.view.rig.tacticalJumpTo({ x: 0, y: -120, z: 100 });
    } else {
      this.sim.setPhase("survey");
      this.sim.emit("phaseChange", "Fleet deployed. NEREUS has command.");
    }
  }

  private teardownMission() {
    if (this.view) {
      this.view.dispose();
      this.view = null;
    }
    this.sim = null;
    this.nereus = null;
    this.audio.resetMissionMix();
    this.hud.destroy();
  }

  private restart(sameSeed: boolean) {
    if (!sameSeed) {
      this.menus.seed = `TRENCH-${Math.floor(Math.random() * 900 + 100)}`;
    }
    const doctrine = this.sim?.doctrine ?? this.menus.doctrine;
    this.menus.doctrine = doctrine;
    this.campaignSortieId = null;
    if (this.campaignOperation) {
      this.startSimulation(doctrine,
        this.campaignOperation === "canyon-passage",
        this.campaignOperation === "silent-minefield",
        this.campaignOperation === "echo-ridge",
        this.campaignOperation === "silent-divide",
        this.campaignOperation === "abyssal-crown"
      );
      if (this.sim && this.campaign) hydrateSimulation(this.campaign, this.sim);
    } else {
      this.startMission(doctrine);
    }
  }

  private quitToMenu() {
    this.campaignOperation=null;
    this.campaignSortieId=null;
    this.pendingCampaignOperation=null;
    this.teardownMission();
    this.state = "menu";
    this.menus.showStart();
  }

  private applySettings(s: Settings) {
    if(s.quality==="custom")this.view?.setCustomQuality(s.graphics);else this.view?.setQuality(s.quality as Quality);
    this.audio.volumes = { master: s.master, effects: s.effects, music: s.music };
    this.audio.applyVolumes();
  }

  // ---------------------------------------------------------------- input

  private bindInput() {
    const gesture = () => this.audio.start();
    window.addEventListener("pointerdown", gesture, { once: true });
    window.addEventListener("keydown", gesture, { once: true });

    this.canvas.addEventListener("pointerdown", (e) => {
      this.pointerDown = true;
      this.pointerMoved = false;
      this.lastPX = e.clientX;
      this.lastPY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!this.pointerDown) return;
      const dx = e.clientX - this.lastPX;
      const dy = e.clientY - this.lastPY;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.pointerMoved = true;
      if (this.pointerMoved) {
        this.view?.rig.onDrag(dx, dy);
        this.hud.tutorialEvent("camera-used");
      }
      this.lastPX = e.clientX;
      this.lastPY = e.clientY;
    });
    this.canvas.addEventListener("pointerup", (e) => {
      this.pointerDown = false;
      if (!this.pointerMoved) this.handleClick(e.clientX, e.clientY);
    });
    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.view?.rig.onWheel(e.deltaY);
        this.hud.tutorialEvent("camera-used");
      },
      { passive: false }
    );

    window.addEventListener("keydown", (e) => {const action=actionFor(e.code,this.menus.settings.bindings);if(this.manualToken&&action&&["throttleUp","throttleDown","steerLeft","steerRight","ascend","descend"].includes(action)){e.preventDefault();this.manualKeys.add(action);}this.handleKey(e);});
    window.addEventListener("keyup",(e)=>{const action=actionFor(e.code,this.menus.settings.bindings);if(action)this.manualKeys.delete(action);});
    window.addEventListener("blur",()=>this.clearManualInput());
    window.addEventListener("resize", () => {
      this.hud.syncViewportInset();
      this.view?.resize();
    });
    document.addEventListener("visibilitychange", () => {
      // rAF pauses naturally; clamp dt on resume via lastT reset
      this.lastT = performance.now() / 1000;
      if(document.hidden){this.audio.suspend();if(this.menus.settings.pauseOnBlur){this.clearManualInput();this.setSpeed(0);}}else this.audio.resume();
    });
  }

  private handleKey(e: KeyboardEvent) {
    const target=e.target as HTMLElement|null;const editable=!!target&&(target.matches("input, textarea, select")||target.isContentEditable);if(editable&&e.key!=="Escape")return;if(e.repeat&&!["w","a","s","d","q","e"].includes(e.key.toLowerCase()))return;
    if (this.state === "debrief") {
      const k = e.key.toLowerCase();
      if (k === "r") this.restart(true);
      else if (k === "n") this.restart(false);
      return;
    }
    if (this.state !== "playing") return;
    if (this.pausedByMenu) {
      if (e.key === "Escape") this.closePauseMenu();
      return;
    }
    const mapped=actionFor(e.code,this.menus.settings.bindings);const roles = ["ATLAS", "GHOST", "LANCER", "ECHO", "MENDER"];
    if(mapped?.startsWith("select")){const index=Number(mapped.slice(-1))-1,u=this.sim?.units.find(x=>x.role===roles[index]);if(u){this.selectedId=u.id;this.hud.tutorialEvent("unit-selected");if(this.camMode==="cinematic")this.setCameraMode("follow");}return;}
    if(mapped==="pause"){e.preventDefault();if(this.manualToken&&this.sim){this.sim.setManualCommand(this.manualToken,{throttle:0});this.manualKeys.clear();}else this.setSpeed(this.speed===0?1:0);return;}
    if(mapped==="speed"){if(this.manualToken)this.executeManualRoleAction();else this.setSpeed(this.speed===2?1:2);return;}
    if(mapped==="camera"){const modes:CameraMode[]=["cinematic","follow","tactical"];this.setCameraMode(modes[(modes.indexOf(this.camMode)+1)%modes.length]);return;}
    if(mapped==="labels"){this.hud.toggleLabelMode();return;}if(mapped==="orders"){this.hud.toggleAIOrders();return;}if(mapped==="sonar"&&this.selectedId){this.sim?.ping(this.selectedId);return;}if(mapped==="manual"){this.manualToken?this.returnToNereus():this.takeManualControl();return;}if(mapped==="countermeasure"&&this.manualToken){this.sim?.deployCountermeasure(this.manualToken.unitId);return;}if(mapped==="roleAction"&&this.manualToken){this.executeManualRoleAction();return;}
    if (e.key >= "1" && e.key <= "5") {
      const u = this.sim?.units.find((x) => x.role === roles[Number(e.key) - 1]);
      if (u) {
        this.selectedId = u.id;
        this.hud.tutorialEvent("unit-selected");
        if (this.camMode === "cinematic") this.setCameraMode("follow");
      }
      return;
    }
    switch (e.key.toLowerCase()) {
      case " ":
        e.preventDefault();
        if(this.manualToken&&this.sim){this.sim.setManualCommand(this.manualToken,{throttle:0});this.manualKeys.clear();}else this.setSpeed(this.speed === 0 ? 1 : 0);
        break;
      case "f":
        if(this.manualToken)this.executeManualRoleAction();else this.setSpeed(this.speed === 2 ? 1 : 2);
        break;
      case "c": {
        const modes: CameraMode[] = ["cinematic", "follow", "tactical"];
        const next = modes[(modes.indexOf(this.camMode) + 1) % modes.length];
        this.setCameraMode(next);
        break;
      }
      case "p":
        if (this.selectedId) this.sim?.ping(this.selectedId);
        break;
      case "r":
        if(this.manualToken)this.sim?.ping(this.manualToken.unitId);
        break;
      case "x":
        if(this.manualToken)this.sim?.deployCountermeasure(this.manualToken.unitId);
        break;
      case "tab":
        if(this.manualToken&&this.sim){e.preventDefault();const current=this.sim.units.findIndex(u=>u.id===this.manualToken!.unitId);for(let n=1;n<=this.sim.units.length;n++){const next=this.sim.units[(current+n)%this.sim.units.length];if(next.state==="active"){const token=this.sim.switchManualControl(this.manualToken,next.id);if(token){this.manualToken=token;this.selectedId=next.id;this.manualKeys.clear();this.hud.setManualMode(true,next.callsign);}break;}}}
        break;
      case "j":
        if (this.selectedId) this.sim?.jam(this.selectedId);
        break;
      case "m":
        this.manualToken?this.returnToNereus():this.takeManualControl();
        break;
      case "o":
        this.hud.toggleAIOrders();
        break;
      case "l":
        this.hud.toggleLabelMode();
        break;
      case "d":
        if (new URLSearchParams(location.search).has("debugPresentation")) {
          this.visualDebug = !this.visualDebug;
          this.view?.setVisualDebug(this.visualDebug);
        }
        break;
      case "k":
        this.pendingShot = { name: `manual-${Math.round(this.elapsed)}`, at: this.elapsed };
        break;
      case "h":
        this.hud.toggleControls();
        break;
      case "escape":
        this.manualKeys.clear();
        this.openPauseMenu();
        break;
    }
  }

  private selectRelative(direction:number){if(!this.sim)return;const active=this.sim.units.filter(unit=>unit.state!=="destroyed");if(!active.length)return;const current=active.findIndex(unit=>unit.id===this.selectedId),index=current<0?(direction>0?0:active.length-1):(current+direction+active.length)%active.length,next=active[index];this.selectedId=next.id;this.hud.tutorialEvent("unit-selected");if(this.camMode==="cinematic")this.setCameraMode("follow");}
  private performInputAction(action:string){if(this.state!=="playing")return;if(action==="selectPrevious")this.selectRelative(-1);else if(action==="selectNext")this.selectRelative(1);else if(action==="camera"){const modes:CameraMode[]=["cinematic","follow","tactical"];this.setCameraMode(modes[(modes.indexOf(this.camMode)+1)%modes.length]);}else if(action==="pause"){if(this.pausedByMenu)this.closePauseMenu();else this.openPauseMenu();}else if(action==="manual"){this.manualToken?this.returnToNereus():this.takeManualControl();}else if(action==="sonar"&&this.selectedId)this.sim?.ping(this.selectedId);else if(action==="countermeasure"&&this.manualToken)this.sim?.deployCountermeasure(this.manualToken.unitId);else if(action==="roleAction"&&this.manualToken)this.executeManualRoleAction();else if(action==="help")this.hud.toggleControls();}
  private pollGamepad(){const pad=navigator.getGamepads?.().find(candidate=>candidate?.connected)??null;const menu=this.state!=="playing"||this.pausedByMenu;const frame=this.gamepad.sample(pad,menu);if(menu){for(const action of frame.pressed){if(action==="menuActivate")(document.activeElement as HTMLElement|null)?.click();else if(action==="menuBack"){if(this.pausedByMenu)this.closePauseMenu();else (document.activeElement as HTMLElement|null)?.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));}else if(action==="menuNext"||action==="menuPrevious"){const focusable=[...document.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(element=>element.offsetParent!==null);if(focusable.length){const current=focusable.indexOf(document.activeElement as HTMLElement),delta=action==="menuNext"?1:-1;focusable[(current+delta+focusable.length)%focusable.length].focus();}}}this.gamepadHeld.clear();return;}for(const action of frame.pressed)this.performInputAction(action);this.gamepadHeld=new Set(frame.held);if((Math.abs(frame.camera.x)+Math.abs(frame.camera.y))>.01){this.view?.rig.onDrag(frame.camera.x*7,frame.camera.y*7);this.hud.tutorialEvent("camera-used");}}

  private handleClick(cx: number, cy: number) {
    if (this.state !== "playing" || !this.view || !this.sim) return;
    const rect=this.canvas.getBoundingClientRect();const nx=((cx-rect.left)/rect.width)*2-1;const ny=-((cy-rect.top)/rect.height)*2+1;
    const pick = this.view.pick(nx, ny);
    if (pick.unitId) {
      this.selectedId = pick.unitId;
      this.hud.tutorialEvent("unit-selected");
      if (this.camMode === "cinematic") this.setCameraMode("follow");
      return;
    }
    if (this.hud.armedOrder && pick.point) {
      const kind = this.hud.armedOrder;
      this.hud.setArmedOrder(null);
      this.sim.issueOrder(kind, pick.point, null);
      return;
    }
    // clicked empty water: deselect
    this.selectedId = null;
  }

  private handleOrderButton(kind: FleetOrderKind) {
    if (!this.sim) return;
    if (kind === "advance" || kind === "investigate") {
      // arm: next terrain click marks the target point
      this.hud.setArmedOrder(this.hud.armedOrder === kind ? null : kind);
      return;
    }
    this.hud.setArmedOrder(null);
    this.sim.issueOrder(kind, null, null);
  }

  private setSpeed(s: GameSpeed) {
    this.speed = s;
    if (s !== 0) this.pausedByMenu = false;
  }

  private takeManualControl(){if(!this.sim)return;if(!this.selectedId){const carrier=this.sim.carrier()??this.sim.units.find(u=>u.state==="active")??this.sim.units[0];this.selectedId=carrier.id;}const consequence=this.sim.unit(this.selectedId);const token=this.sim.acquireManualControl(this.selectedId);if(!token){if(consequence?.state!=="active")this.sim.emit("warning",`${consequence?.callsign??"Selected submarine"} cannot take manual control in its current state.`,consequence?{...consequence.pos}:null,consequence?.id??null);return;}this.manualToken=token;this.clearManualInput();this.setCameraMode("follow");this.hud.setManualMode(true,consequence?.callsign??"");}
  private returnToNereus(){if(!this.sim||!this.manualToken)return;this.sim.releaseManualControl(this.manualToken);this.manualToken=null;this.clearManualInput();this.hud.setManualMode(false,"");}

  private applyManualInput(){if(!this.sim||!this.manualToken||this.speed===0)return;const u=this.sim.unit(this.manualToken.unitId);if(!u||u.control.mode!=="manual")return;const held=(action:string)=>this.manualKeys.has(action)||this.gamepadHeld.has(action),dt=SIM.DT;let heading=u.control.command.heading,depth=u.control.command.depth,throttle=u.control.command.throttle;if(held("steerLeft"))heading-=specRole(u.role).turnRate*dt*1.6;if(held("steerRight"))heading+=specRole(u.role).turnRate*dt*1.6;if(held("ascend"))depth=Math.max(18,depth-specRole(u.role).vertRate*dt*4);if(held("descend"))depth=Math.min(310,depth+specRole(u.role).vertRate*dt*4);if(held("throttleUp"))throttle=Math.min(specRole(u.role).maxSpeed,throttle+specRole(u.role).accel*dt);if(held("throttleDown"))throttle=Math.max(0,throttle-specRole(u.role).accel*dt*1.5);this.sim.setManualCommand(this.manualToken,{heading,depth,throttle});}
  private executeManualRoleAction(){if(!this.sim||!this.manualToken)return;const u=this.sim.unit(this.manualToken.unitId);if(!u)return;if(u.role==="ATLAS")this.sim.emit("phaseChange","Atlas Command Pulse requested immediate NEREUS reassessment.",{...u.pos},u.id);else if(u.role==="GHOST"){this.sim.setManualCommand(this.manualToken,{throttle:Math.min(u.speed,specRole(u.role).silentSpeed)});this.sim.emit("phaseChange","Ghost entered Silent Observation.",{...u.pos},u.id);}else if(u.role==="ECHO")this.sim.ping(u.id);else if(u.role==="LANCER"){const hostile=[...this.sim.echoRidge?.contacts.values()??[]].find(c=>c.classification==="hostile");if(hostile)this.sim.launchDefensiveInterceptor(hostile.id);else{const target=[...this.sim.minefield?.contacts.values()??[]].find(c=>c.classification==="mine"&&!c.disabled);if(target)this.sim.neutralizeMine(target.id);else this.sim.emit("warning","No authorized confirmed threat is available for defensive action.",{...u.pos},u.id);}}else this.sim.emit("phaseChange","Mender requested a validated repair or recovery assignment.",{...u.pos},u.id);}
  private executeSpecialCommand(command:string){if(!this.sim)return;const selected=this.selectedId?this.sim.unit(this.selectedId):null;if(command==="silent")this.sim.updateFleetDirectives({speed:"silent",emissions:"passive"});else if(command==="detect"){this.sim.updateFleetDirectives({emissions:"maximum"});const echo=this.sim.units.find(u=>u.role==="ECHO"&&u.state==="active");if(echo)this.sim.ping(echo.id);}else if(command==="regroup")this.sim.issueOrder("regroup");else if(command==="abort"){this.sim.issueOrder("hold");this.sim.emit("phaseChange","Current plan aborted; NEREUS established safe holding positions.");}else if(command==="investigate"&&selected)this.sim.issueOrder("investigate",selected.pos,selected.id);else if(command==="focus"&&selected)this.sim.issueOrder("advance",selected.pos,selected.id);else if(command==="rescue"&&selected)this.sim.issueOrder("repairs",null,selected.id);else if(command==="escort"&&selected)this.sim.issueOrder("regroup",null,selected.id);else if(command==="shadow"&&selected)this.sim.issueOrder("investigate",selected.pos,selected.id);else if(command==="disperse"){this.sim.updateFleetDirectives({formation:"search",cohesion:"independent"});this.sim.emit("phaseChange","Emergency disperse: wide search formation, independent assignments.");}else this.sim.emit("phaseChange",`${command} requested; NEREUS is assigning suitable submarines.`,selected?{...selected.pos}:null,selected?.id??null);}
  private commandContext():CommandContext{
    const sim=this.sim!;
    const entities:CommandContext["entities"]=sim.units.map(u=>({id:u.id,label:u.callsign,kind:"unit",pos:{...u.pos},manual:u.control.mode==="manual",connected:sim.network.links.get(u.id)?.state!=="disconnected"}));
    for(const c of sim.contacts.values())entities.push({id:c.id,label:c.id,kind:"contact",pos:{...c.pos},classification:c.classification??c.kind});
    if(sim.minefield)for(const c of sim.minefield.contacts.values())entities.push({id:c.id,label:c.id,kind:"contact",pos:{...c.estimate},classification:c.classification});
    if(sim.echoRidge)for(const c of sim.echoRidge.contacts.values())entities.push({id:c.id,label:c.id,kind:"contact",pos:{...c.estimate},classification:c.classification});
    return{entities,selectedUnitId:this.selectedId,selectedContactId:null,revision:sim.network.topologyRevision+sim.events.length};
  }
  private submitConsoleCommand(input:string){if(!this.sim)return;const command=this.commandController.parse(input,this.commandContext(),this.sim.now);if(command.parse.status==="ready"&&command.parse.confirmation==="routine")this.executeConsoleCommand(false);else this.refreshConsole();}
  private executeConsoleCommand(confirmed:boolean){if(!this.sim)return;this.commandController.execute(this.sim,this.commandContext(),confirmed);this.refreshConsole();}
  private refreshConsole(){if(!this.sim)return;const atlas=this.sim.units.find(u=>u.role==="ATLAS")!;this.hud.updateCommandConsole(this.commandController.pending,this.commandController.history,this.sim.network.links.get(atlas.id)?.state??"disconnected");}

  private toggleMute() {
    this.audio.setMuted(!this.audio.muted);
    this.hud.setMuted(this.audio.muted);
  }

  private setCameraMode(m: CameraMode) {
    this.camMode = m;
    this.view?.rig.setMode(m);
    if (m === "follow" && !this.selectedId && this.sim) {
      // follow the carrier or Atlas by default
      const carrier = this.sim.carrier();
      this.selectedId = (carrier ?? this.sim.units[0]).id;
    }
    if (m === "tactical" && this.sim && this.view) {
      const focus = this.selectedId ? this.sim.unit(this.selectedId)!.pos : this.sim.carrier()?.pos ?? this.sim.units[0].pos;
      this.view.rig.tacticalJumpTo(focus);
    }
  }

  private openPauseMenu() {
    if (this.state !== "playing") return;
    this.manualKeys.clear();
    this.pausedByMenu = true;
    this.menus.showPause();
  }

  private closePauseMenu() {
    this.pausedByMenu = false;
    this.menus.hideAll();
  }

  // ------------------------------------------------------------ sim events

  private handleSimEvent(e: SimEvent) {
    this.nereus?.onEvent(e);
    this.audio.event(e);
    this.hud.pushEvent(e);
    if (e.pos && this.view) {
      switch (e.kind) {
        case "mineHit":
        case "torpedoHit":
          this.view.effects.spawnImpact(e.pos, e.kind === "mineHit" ? 1.4 : 1);
          break;
        case "unitDestroyed":
          this.view.effects.spawnImpact(e.pos, 1.8);
          break;
        case "unitDamaged":
          this.view.effects.spawnBubbles(e.pos, 8, 1.2);
          break;
        case "ping":
          if(this.view.sonarEffectsEnabled)this.view.effects.spawnPing(e.pos);
          break;
        default:
          break;
      }
      // cinematic focus on significant events
      if (
        ["nodeAlert", "mineHit", "torpedoHit", "unitDamaged", "unitDestroyed", "unitDisabled", "coreRecovered", "objectiveDone"].includes(
          e.kind
        )
      ) {
        this.eventFocus = e.pos;
        this.eventFocusAt = this.sim?.now ?? 0;
      }
      if (this.sim?.canyonTrial && /rockfall|obstruction/i.test(e.text) && this.camMode === "cinematic") {
        this.eventFocus = e.pos;
        this.eventFocusAt = this.sim.now;
      }
    }
    if (this.sim?.outcome && this.outcomeAt < 0) {
      this.outcomeAt = this.elapsed;
    }
  }

  // --------------------------------------------------------------- main loop

  start() {
    if (this.view && this.sim && this.nereus) {
      this.view.rig.update(0, {
        focus: this.computeFocus(),
        featured: { pos: this.sim.units[0].pos, heading: this.sim.units[0].heading },
        selected: null,
        fleet: this.sim.aliveUnits().map((u) => u.pos),
        terrain: this.sim.mission.terrain,
        interacting: false,
        reducedMotion: this.menus.settings.reducedMotion
      });
      this.view.sync(1, 0, this.elapsed, this.selectedId, this.camMode);
      this.view.render();
      this.hud.update(this.sim, this.nereus, this.selectedId, this.speed, this.camMode, this.elapsed + 1);
    }
    this.lastT = performance.now() / 1000;
    let fatal=false;const loop = () => {
      if(fatal)return;
      requestAnimationFrame(loop);
      try{
      const now = performance.now() / 1000;
      this.pollGamepad();
      let dt = Math.min(0.1, now - this.lastT);
      this.lastT = now;

      const running = this.state === "playing" && this.sim && !this.sim.outcome && (this.view?.contextLifecycle.available ?? true);
      const effectiveSpeed = this.pausedByMenu ? 0 : this.speed;

      if (running && effectiveSpeed > 0) {
        this.accumulator += dt * effectiveSpeed;
        let steps = 0;
        const maxSteps = 8;
        while (this.accumulator >= SIM.DT && steps < maxSteps) {
          this.applyManualInput();
          this.sim!.step();
          this.nereus!.update();
          this.accumulator -= SIM.DT;
          steps++;
        }
        if (steps >= maxSteps) this.accumulator = 0; // spiral-of-death guard
      }

      this.elapsed += dt;
      const alpha = effectiveSpeed > 0 && running ? this.accumulator / SIM.DT : 1;

      if (this.view && this.sim) {
        // pick cinematic focus
        const focus = this.computeFocus();
        const selected = this.selectedId ? this.sim.unit(this.selectedId) : null;
        const featured = selected ?? this.sim.carrier() ?? this.sim.units[0];
        this.view.rig.update(dt, {
          focus,
          featured: { pos: featured.pos, heading: featured.heading },
          selected:
            this.camMode === "follow" && selected
              ? { pos: selected.pos, heading: selected.heading }
              : null,
          fleet: this.sim.aliveUnits().map((u) => u.pos),
          terrain: this.sim.mission.terrain,
          interacting: this.pointerDown,
          reducedMotion: this.menus.settings.reducedMotion
        });
        this.view.sync(alpha, dt, this.elapsed, this.selectedId, this.camMode);
        this.view.render();

        // dev screenshot capture (same-tick, so the drawing buffer is valid)
        if (this.pendingShot && this.elapsed >= this.pendingShot.at) {
          const name = this.pendingShot.name;
          this.pendingShot = null;
          const data = awaitFrameCapture(this.canvas, document.getElementById("app")!);
          void data.then((png) => fetch("/__shot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, data: png })
          })).catch(() => {});
          // low-res luminance/hue probe for text-based inspection
          const gl = this.view.renderer.getContext();
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const GW = 96;
          const GH = 40;
          const grid: number[] = [];
          for (let gy = 0; gy < GH; gy++) {
            for (let gx = 0; gx < GW; gx++) {
              const sx = Math.floor((gx / GW) * w);
              const sy = Math.floor((gy / GH) * h);
              const i = (sy * w + sx) * 4;
              grid.push(px[i], px[i + 1], px[i + 2]);
            }
          }
          fetch("/__grid", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, w: GW, h: GH, data: grid })
          }).catch(() => {});
        }

        if (this.pendingLayoutAudit && this.elapsed >= this.pendingLayoutAudit.at) {
          const name = this.pendingLayoutAudit.name;
          this.pendingLayoutAudit = null;
          const selectors = ["#scene", ".time-cluster", ".control-center", ".bottom-bar", ".tutorial-card", ".controls-overlay", ".menu-box"];
          const rects = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLElement>(selector)].filter(element=>element.offsetParent!==null).map((element,index) => {
            const r = element.getBoundingClientRect();
            return { selector:`${selector}${index?`[${index}]`:""}`, x:r.x, y:r.y, width:r.width, height:r.height, scrollWidth:element.scrollWidth, clientWidth:element.clientWidth, scrollHeight:element.scrollHeight, clientHeight:element.clientHeight };
          }));
          const clipped = rects.filter((r) => r.x < 0 || r.y < 0 || r.x + r.width > innerWidth || r.y + r.height > innerHeight);
          const horizontalOverflow=rects.filter(r=>r.scrollWidth>r.clientWidth+1);
          const controls=[...document.querySelectorAll<HTMLElement>("button,input,select,textarea")].filter(element=>element.offsetParent!==null).map((element,index)=>{const r=element.getBoundingClientRect();return{selector:`${element.tagName.toLowerCase()}[${index}]`,label:(element.getAttribute("aria-label")||element.textContent||element.getAttribute("title")||"").trim().slice(0,80),x:r.x,y:r.y,width:r.width,height:r.height}});
          const clippedControls=controls.filter(r=>r.x<0||r.y<0||r.x+r.width>innerWidth||r.y+r.height>innerHeight);
          const undersizedControls=matchMedia("(pointer: coarse)").matches?controls.filter(r=>r.width<44||r.height<44):[];
          const overlaps: string[][] = [];
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i];
              const b = rects[j];
              if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) {
                overlaps.push([a.selector, b.selector]);
              }
            }
          }
          fetch("/__layout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, viewport: { width: innerWidth, height: innerHeight, coarsePointer:matchMedia("(pointer: coarse)").matches, portrait:matchMedia("(orientation: portrait)").matches }, documentOverflow:{horizontal:document.documentElement.scrollWidth>innerWidth+1,vertical:document.documentElement.scrollHeight>innerHeight+1}, rects, clipped, horizontalOverflow, controls:controls.length, clippedControls, undersizedControls, overlaps })
          }).catch(() => {});
        }

        this.hud.update(this.sim, this.nereus!, this.selectedId, effectiveSpeed as GameSpeed, this.camMode, this.elapsed);
        this.commandController.update(this.sim);
        this.refreshConsole();

        // audio tension: any alerted node or recent damage
        const tension = this.sim.nodes.some((n) => n.state === "alert") ? 1 : this.sim.nodes.some((n) => n.state === "suspicious") ? 0.4 : 0;
        const fleetSpeed = Math.max(...this.sim.units.map((u) => u.speed / 24), 0);
        const heard = this.selectedId ? this.sim.unit(this.selectedId) : this.sim.units[0];
        this.audio.update(dt, tension, fleetSpeed, heard?.role ?? "ATLAS", Math.min(1, (heard?.depth ?? 0) / 320));

        // one-time render stats for diagnostics
        this.frameCount++;
        this.fpsSampleFrames++;if(this.elapsed-this.fpsSampleAt>=1){this.measuredFps=this.fpsSampleFrames/(this.elapsed-this.fpsSampleAt);this.fpsSampleFrames=0;this.fpsSampleAt=this.elapsed;}this.hud.updatePerformance(this.menus.settings.performanceDisplay,this.measuredFps,this.view.renderer.info.render.calls,this.view.renderer.info.render.triangles);
        if (!this.statsLogged && this.elapsed > 6) {
          this.statsLogged = true;
          const info = this.view.renderer.info.render;
          const fps = this.frameCount / (this.elapsed - this.fpsWindowStart);
          console.log(
            `[abyss] render: ${info.calls} draw calls, ${info.triangles} triangles, ~${Math.round(fps)} fps (first 6s, ${this.menus.settings.quality})`
          );
        }

        // debrief after outcome
        if (this.sim.outcome && !this.debriefShown && this.outcomeAt >= 0 && this.elapsed - this.outcomeAt > 2.2) {
          this.settleCampaignSortie();
          this.debriefShown = true;
          this.state = "debrief";
          this.menus.showDebrief(this.sim, this.nereus!);
        }
      }
      }catch(error){fatal=true;console.error("Fatal frame error",error);this.setSpeed(0);document.getElementById("webgl-error")?.classList.remove("hidden");}
    };
    loop();
  }

  private computeFocus(): Vec3 {
    const sim = this.sim!;
    // recent significant event
    if (this.eventFocus && sim.now - this.eventFocusAt < 10 && this.camMode === "cinematic") {
      return this.eventFocus;
    }
    if (this.selectedId) {
      const u = sim.unit(this.selectedId);
      if (u) return u.pos;
    }
    const carrier = sim.carrier();
    if (carrier) return carrier.pos;
    // centroid of active units
    const active = sim.units.filter((u) => u.state !== "destroyed");
    if (active.length === 0) return vec3(0, -100, 0);
    let x = 0;
    let y = 0;
    let z = 0;
    for (const u of active) {
      x += u.pos.x;
      y += u.pos.y;
      z += u.pos.z;
    }
    return vec3(x / active.length, y / active.length, z / active.length);
  }

  memoryDiagnostics() {
    const renderMemory=this.view?.renderer.info.memory;
    return {
      state:this.state,
      elapsedSeconds:Number(this.elapsed.toFixed(1)),
      simulationSeconds:Number((this.sim?.now??0).toFixed(1)),
      events:this.sim?.events.length??0,
      logisticsEvents:this.sim?.logisticsEvents.length??0,
      decisions:this.nereus?.decisions.length??0,
      commandLog:this.nereus?.commandLog.length??0,
      networkMessages:this.sim?.network.messages.length??0,
      projectiles:this.sim?.projectiles.length??0,
      renderer:{geometries:renderMemory?.geometries??0,textures:renderMemory?.textures??0,programs:this.view?.renderer.info.programs?.length??0},
      domNodes:document.getElementsByTagName("*").length
    };
  }

  advanceMemoryAudit(seconds:number) {
    if(!this.sim||!this.nereus||this.sim.outcome)return this.memoryDiagnostics();
    for(let i=0;i<Math.min(seconds,60)*60&&!this.sim.outcome;i++){this.sim.step();this.nereus.update();}
    return this.memoryDiagnostics();
  }
}

async function awaitFrameCapture(canvas: HTMLCanvasElement, app: HTMLElement): Promise<string> {
  if (app.querySelector("#hud:not(.hidden)")) {
    const { domToPng } = await import("modern-screenshot");
    return domToPng(app, {
      scale: 1,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: "#061824",
      maximumCanvasSize: 8192 * 8192
    });
  }
  return canvas.toDataURL("image/png");
}
