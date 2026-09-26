import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { Simulation } from "../sim/simulation";
import { spec } from "../sim/units";
import { Unit, Vec3 } from "../types";
import { WORLD } from "../config";
import { buildSubmarine, SubmarineModel } from "./submarineMesh";
import {
  buildExtraction,
  buildCanyonLife,
  buildFacility,
  buildMine,
  buildObjectiveMarker,
  buildRocks,
  buildSecurityNode,
  buildTerrain,
  setTerrainDetail,
  buildVents,
  buildWrecks
} from "./terrainMesh";
import { Caustics, FishSchools, LightShafts, MarineSnow, OceanAtmosphere } from "./ocean";
import { Effects } from "./effects";
import { CameraMode, CameraRig } from "./cameras";
import { GraphicsContextLifecycle } from "./contextLifecycle";
import { GraphicsSettings, GRAPHICS_PRESETS, validateGraphics } from "./graphicsSettings";

export type Quality = "low" | "medium" | "high" | "custom";

interface UnitView {
  model: SubmarineModel;
  bubbleTimer: number;
  destroyedTilt: number;
  propSpin: number;
  trailAccumulator: number;
  sedimentAccumulator: number;
}

export type LabelMode = "all" | "selected" | "off";

interface HtmlUnitLabel {
  root: HTMLDivElement;
  task: HTMLElement;
  x: number;
  y: number;
  initialized: boolean;
}

const NODE_STATE_COLORS: Record<string, number> = {
  dormant: 0x6fe8a0,
  suspicious: 0xffb347,
  alert: 0xff5340,
  cooldown: 0xffb347,
  disabled: 0x3a4650,
  destroyed: 0x3a4650
};

/** per-role overlay hue: consistent unit identifiers, restrained palette */
const ROLE_COLORS: Record<string, number> = {
  ATLAS: 0x7fd8e8,
  GHOST: 0xa8e6cf,
  LANCER: 0xffb347,
  ECHO: 0xc3a6ff,
  MENDER: 0x6fe8a0
};

/** per-unit "Show AI Orders" overlay objects */
interface UnitOverlay {
  route: THREE.Line;
  dest: THREE.Mesh;
  tick: THREE.Mesh;
  link: THREE.Line;
  routeKey: string;
}

interface TrialView {
  group: THREE.Group;
  corridorLines: Map<string, THREE.Line>;
  boundaryLines: Map<string, THREE.LineLoop>;
  rockfall: THREE.Group;
  regroup: THREE.Mesh;
  rockfallStartedAt: number;
  rockfallSettled: boolean;
}

/** compact task label for the world-space tag (from the actual assignment) */
function shortTaskLabel(u: Unit, sim: Simulation): string {
  const t = u.task;
  const targetUnit = t.targetId ? sim.unit(t.targetId) : undefined;
  switch (t.kind) {
    case "idle": return "STANDBY";
    case "hold": return "HOLD";
    case "scout": return t.targetId === "order-advance" ? "ADVANCE" : "SCOUT";
    case "survey": return t.targetId === "surveyA" ? "SURVEY N" : t.targetId === "surveyB" ? "SURVEY S" : "SURVEY";
    case "escort": return `ESCORT ${targetUnit?.callsign ?? ""}`.trim();
    case "repair": return `REPAIR→${targetUnit?.callsign ?? "ALLY"}`;
    case "rescue": return `RESCUE→${targetUnit?.callsign ?? "ALLY"}`;
    case "support": return "AWAIT REPAIR";
    case "attack": return "ATTACK NODE";
    case "distract": return "DISTRACT NODE";
    case "jam": return "JAM NODE";
    case "recover": return "RECOVER CORE";
    case "fetchcore": return "FETCH CORE";
    case "exfil": return t.targetId?.startsWith("withdraw") ? "WITHDRAW" : "EXFIL";
    case "regroup": return "REGROUP";
    case "investigate": return "INVESTIGATE";
    case "transit": return u.task.corridorId === "narrow" ? "NARROW CUT" : "OUTER ROUTE";
  }
}

/** soft radial dot for tactical markers */
function dotTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.85)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class WorldView {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  rig: CameraRig;
  atmosphere: OceanAtmosphere;
  snow: MarineSnow;
  fish: FishSchools;
  shafts: LightShafts;
  caustics: Caustics;
  effects: Effects;
  quality: Quality = "medium";

  private composer: EffectComposer;
  private renderPass: RenderPass;
  private outputPass: OutputPass;
  private bloom: UnrealBloomPass;
  private fxaa: ShaderPass;
  private sunLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;

  private unitViews = new Map<string, UnitView>();
  private nodeViews = new Map<string, { group: THREE.Group; ring: THREE.Mesh; head: THREE.Mesh; radius: THREE.Mesh }>();
  private mineViews = new Map<string, THREE.Group>();
  private minefieldContactViews = new Map<string, { ring: THREE.LineLoop; marker: THREE.Mesh }>();
  private hostileViews = new Map<string, THREE.Group>();
  private projViews = new Map<string, THREE.Mesh>();
  private objMarkers = new Map<string, THREE.Mesh>();
  private selectionRing: THREE.Mesh;
  private clearanceRing: THREE.Mesh;
  private pathLine: THREE.Line;
  private coreBeacon: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private terrainMesh: THREE.Mesh;
  private sim: Simulation;
  private fogScaleTarget = 1;
  private lastPathKey = "";
  private fillLight: THREE.PointLight;
  private tacticalSprites = new Map<string, THREE.Sprite>();
  private tacticalSpriteTex: THREE.Texture;
  /** "Show AI Orders" overlay: routes, destinations, labels, task links */
  private aiOverlay = new THREE.Group();
  private unitOverlays = new Map<string, UnitOverlay>();
  private trialView: TrialView | null = null;
  private labelLayer: HTMLDivElement;
  private htmlLabels = new Map<string, HtmlUnitLabel>();
  private labelMode: LabelMode = "all";
  private resizeObserver: ResizeObserver | null = null;
  readonly contextLifecycle = new GraphicsContextLifecycle();
  private contextStatus: HTMLDivElement;
  private readonly onContextLost: (event: Event) => void;
  private readonly onContextRestored: () => void;
  private scratchAnchor = new THREE.Vector3();
  private graphics:GraphicsSettings=GRAPHICS_PRESETS.medium;
  private debugGroup = new THREE.Group();
  private debugUnits = new Map<string, { bounds: THREE.Mesh; forward: THREE.ArrowHelper; command: THREE.ArrowHelper }>();
  private manualProjection: THREE.Line;

  constructor(canvas: HTMLCanvasElement, sim: Simulation, quality: Quality) {
    this.sim = sim;
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance"
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.26;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.rig = new CameraRig(window.innerWidth / window.innerHeight);
    this.atmosphere = new OceanAtmosphere(this.scene);

    // --- lights ---
    this.hemi = new THREE.HemisphereLight(0x5c9baa, 0x0b141c, 1.18);
    this.scene.add(this.hemi);
    this.sunLight = new THREE.DirectionalLight(0xaee2ea, 1.9);
    this.sunLight.position.set(300, 400, 150);
    this.scene.add(this.sunLight);
    const amb = new THREE.AmbientLight(0x294b58, 0.72);
    this.scene.add(amb);
    // camera fill: lifts subjects near the lens without washing the scene
    this.fillLight = new THREE.PointLight(0x4b7d8b, 125, 360, 1.8);
    this.scene.add(this.fillLight);

    // --- world geometry ---
    this.terrainMesh = buildTerrain(sim.mission);
    this.scene.add(this.terrainMesh);
    this.scene.add(buildRocks(sim.mission));
    this.scene.add(buildCanyonLife(sim.mission));
    this.scene.add(buildWrecks(sim.mission));
    this.scene.add(buildFacility(sim.mission));
    this.scene.add(buildVents(sim.mission));
    this.scene.add(buildExtraction(sim.mission));
    if (sim.mission.canyonTrial) this.trialView = this.buildTrialView();

    // --- units ---
    this.tacticalSpriteTex = dotTexture();
    for (const u of sim.units) {
      const model = buildSubmarine(u.role);
      model.group.traverse(object=>{const mesh=object as THREE.Mesh;if(mesh.isMesh){mesh.geometry.computeBoundingSphere();mesh.userData.detailRadius=mesh.geometry.boundingSphere?.radius??99;}});
      model.group.userData.unitId = u.id;
      this.scene.add(model.group);
      this.unitViews.set(u.id, { model, bubbleTimer: 0, destroyedTilt: 0, propSpin: 0, trailAccumulator: 0, sedimentAccumulator: 0 });
      // tactical marker sprite (distance-independent)
      const smat = new THREE.SpriteMaterial({
        map: this.tacticalSpriteTex,
        color: 0x7fd8e8,
        depthTest: false,
        transparent: true,
        opacity: 0.95
      });
      const sprite = new THREE.Sprite(smat);
      sprite.renderOrder = 5;
      sprite.visible = false;
      this.scene.add(sprite);
      this.tacticalSprites.set(u.id, sprite);
    }

    // --- security nodes (hidden until detected) ---
    for (const n of sim.nodes) {
      const v = buildSecurityNode();
      v.group.position.copy(n.pos as THREE.Vector3Like);
      v.group.visible = false;
      this.scene.add(v.group);
      // detection radius disc on the seabed
      const discGeo = new THREE.RingGeometry(n.detectRadius * 0.94, n.detectRadius, 48);
      discGeo.rotateX(-Math.PI / 2);
      const disc = new THREE.Mesh(
        discGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffb347,
          transparent: true,
          opacity: 0.1,
          depthWrite: false,
          side: THREE.DoubleSide
        })
      );
      disc.position.set(n.pos.x, n.pos.y + 2, n.pos.z);
      disc.visible = false;
      this.scene.add(disc);
      this.nodeViews.set(n.id, { group: v.group, ring: v.ring, head: v.head, radius: disc });
    }

    // --- mines (hidden until detected) ---
    for (const m of sim.mines) {
      const g = buildMine();
      g.position.copy(m.pos as THREE.Vector3Like);
      g.visible = false;
      this.scene.add(g);
      this.mineViews.set(m.id, g);
    }
    if(sim.mission.silentMinefield){
      for(const truth of sim.mission.silentMinefield.contacts){
        const pts=Array.from({length:40},(_,i)=>{const a=i/40*Math.PI*2;return new THREE.Vector3(Math.cos(a),0,Math.sin(a));});
        const ring=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineDashedMaterial({color:0xffb347,transparent:true,opacity:.48,dashSize:.25,gapSize:.18,depthWrite:false}));ring.computeLineDistances();ring.visible=false;this.scene.add(ring);
        const marker=new THREE.Mesh(new THREE.OctahedronGeometry(4,0),new THREE.MeshBasicMaterial({color:0xffb347,transparent:true,opacity:.75,depthWrite:false}));marker.visible=false;this.scene.add(marker);this.minefieldContactViews.set(truth.id,{ring,marker});
      }
    }
    if(sim.mission.echoRidge){for(const spawn of sim.mission.echoRidge.droneSpawns){const g=new THREE.Group(),mat=new THREE.MeshStandardMaterial({color:spawn.role==="attack"?0x60342e:spawn.role==="pursuit"?0x4b4540:0x3b4d53,roughness:.48,metalness:.72});const body=new THREE.Mesh(new THREE.ConeGeometry(spawn.role==="attack"?7:4.5,spawn.role==="attack"?30:22,8),mat);body.rotation.x=Math.PI/2;g.add(body);for(const side of[-1,1]){const fin=new THREE.Mesh(new THREE.BoxGeometry(10,.5,5),mat);fin.position.set(side*5,0,-5);g.add(fin);}g.visible=false;this.scene.add(g);this.hostileViews.set(spawn.id,g);}}

    // --- objective markers ---
    for (const o of sim.objectives) {
      if (o.kind === "extraction") continue; // extraction structure marks itself
      const marker = buildObjectiveMarker(o.kind === "facility" ? 0xffb347 : 0x7fd8e8);
      marker.position.copy(o.pos as THREE.Vector3Like);
      if (o.kind === "facility") {
        marker.scale.setScalar(2.5);
        marker.visible = false;
      }
      this.scene.add(marker);
      this.objMarkers.set(o.id, marker);
    }

    // --- selection ring ---
    const selGeo = new THREE.RingGeometry(12, 14, 32);
    selGeo.rotateX(-Math.PI / 2);
    this.selectionRing = new THREE.Mesh(
      selGeo,
      new THREE.MeshBasicMaterial({ color: 0x7fd8e8, transparent: true, opacity: 0.65, depthWrite: false })
    );
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);
    const clearanceGeo = new THREE.RingGeometry(0.96, 1, 48);
    clearanceGeo.rotateX(-Math.PI / 2);
    this.clearanceRing = new THREE.Mesh(
      clearanceGeo,
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide })
    );
    this.clearanceRing.visible = false;
    this.scene.add(this.clearanceRing);

    // --- path line ---
    const pathGeo = new THREE.BufferGeometry();
    pathGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    this.pathLine = new THREE.Line(
      pathGeo,
      new THREE.LineBasicMaterial({ color: 0x7fd8e8, transparent: true, opacity: 0.55 })
    );
    this.pathLine.visible = false;
    this.scene.add(this.pathLine);

    // --- AI order overlays (per unit: route, destination, waypoint tick, label, task link) ---
    this.aiOverlay.name = "aiOrders";
    for (const u of sim.units) {
      const color = ROLE_COLORS[u.role] ?? 0x7fd8e8;
      const routeGeo = new THREE.BufferGeometry();
      routeGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
      const route = new THREE.Line(
        routeGeo,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3, depthWrite: false })
      );
      route.frustumCulled = false;
      const dest = new THREE.Mesh(
        new THREE.RingGeometry(5, 6.6, 24),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
      );
      dest.rotation.x = -Math.PI / 2;
      const tick = new THREE.Mesh(
        new THREE.SphereGeometry(1.6, 8, 6),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false })
      );
      const linkGeo = new THREE.BufferGeometry();
      linkGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
      const link = new THREE.Line(
        linkGeo,
        new THREE.LineBasicMaterial({ color: 0x6fe8a0, transparent: true, opacity: 0.5, depthWrite: false })
      );
      link.frustumCulled = false;
      this.aiOverlay.add(route, dest, tick, link);
      this.unitOverlays.set(u.id, { route, dest, tick, link, routeKey: "" });
    }
    this.scene.add(this.aiOverlay);

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "world-label-layer";
    canvas.parentElement!.appendChild(this.labelLayer);
    for (const u of sim.units) {
      const root = document.createElement("div");
      root.className = "world-label";
      root.dataset.unit = u.id;
      root.style.setProperty("--unit-color", `#${(ROLE_COLORS[u.role] ?? 0x7fd8e8).toString(16).padStart(6, "0")}`);
      const callsign = document.createElement("strong");
      callsign.textContent = u.callsign;
      const task = document.createElement("span");
      task.className = "world-label-task";
      root.append(callsign, task);
      this.labelLayer.append(root);
      this.htmlLabels.set(u.id, { root, task, x: 0, y: 0, initialized: false });
    }
    this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.resize()) : null;
    this.resizeObserver?.observe(canvas);
    this.debugGroup.visible = false;
    for (const u of sim.units) {
      const bounds = new THREE.Mesh(new THREE.CapsuleGeometry(spec(u.role).radius, Math.max(1, spec(u.role).length - spec(u.role).radius * 2), 4, 12), new THREE.MeshBasicMaterial({ color: 0x6fe8a0, wireframe: true, transparent: true, opacity: .32, depthWrite: false }));
      bounds.rotation.x = Math.PI / 2;
      const forward = new THREE.ArrowHelper(new THREE.Vector3(0,0,1), new THREE.Vector3(), 34, 0x7fd8e8, 6, 3);
      const command = new THREE.ArrowHelper(new THREE.Vector3(0,0,1), new THREE.Vector3(), 42, 0xffb347, 7, 3);
      this.debugGroup.add(bounds, forward, command);
      this.debugUnits.set(u.id, { bounds, forward, command });
    }
    this.scene.add(this.debugGroup);
    const projectionGeo=new THREE.BufferGeometry();projectionGeo.setAttribute("position",new THREE.BufferAttribute(new Float32Array(20*3),3));
    this.manualProjection=new THREE.Line(projectionGeo,new THREE.LineBasicMaterial({color:0xffb347,transparent:true,opacity:.72,depthWrite:false}));this.manualProjection.visible=false;this.scene.add(this.manualProjection);

    // --- dropped-core beacon ---
    this.coreBeacon = new THREE.Mesh(
      new THREE.OctahedronGeometry(4, 0),
      new THREE.MeshStandardMaterial({
        color: 0x140f04,
        emissive: new THREE.Color(0xffb347),
        emissiveIntensity: 2.5
      })
    );
    this.coreBeacon.visible = false;
    this.scene.add(this.coreBeacon);

    // --- atmosphere & effects ---
    this.snow = new MarineSnow(1600, sim.mission.seed);
    this.scene.add(this.snow.points);
    this.fish = new FishSchools(sim.mission.seed);
    this.scene.add(this.fish.points);
    const basin = sim.mission.deployment[0];
    this.shafts = new LightShafts(sim.mission.seed, { x: basin.x, z: basin.z });
    this.scene.add(this.shafts.group);
    this.caustics = new Caustics(basin.x, basin.z, 420, -this.sim.mission.terrain.depthAt(basin.x, basin.z) + 3);
    this.scene.add(this.caustics.mesh);
    this.effects = new Effects(this.scene);

    // --- postprocessing ---
    this.composer = null!;this.renderPass=null!;this.bloom=null!;this.fxaa=null!;this.outputPass=null!;
    this.buildComposer();
    this.contextStatus=document.createElement("div");this.contextStatus.className="graphics-context-status hidden";this.contextStatus.setAttribute("role","status");canvas.parentElement!.appendChild(this.contextStatus);
    this.onContextLost=(event)=>{event.preventDefault();this.contextLifecycle.lose();canvas.dataset.contextState=this.contextLifecycle.state;this.contextStatus.textContent="Graphics context lost — simulation paused. Waiting for the browser to restore rendering…";this.contextStatus.classList.remove("hidden");};
    this.onContextRestored=()=>void this.restoreContext();
    canvas.addEventListener("webglcontextlost",this.onContextLost);
    canvas.addEventListener("webglcontextrestored",this.onContextRestored);
    canvas.dataset.contextState=this.contextLifecycle.state;canvas.dataset.contextGeneration=String(this.contextLifecycle.generation);

    this.setQuality(quality);
    this.resize();
  }

  private buildComposer(){const target=new THREE.WebGLRenderTarget(1,1,{samples:this.graphics.antiAliasing==="msaa+fxaa"?4:0});this.composer=new EffectComposer(this.renderer,target);this.renderPass=new RenderPass(this.scene,this.rig.camera);this.composer.addPass(this.renderPass);this.bloom=new UnrealBloomPass(new THREE.Vector2(Math.max(1,this.renderer.domElement.clientWidth),Math.max(1,this.renderer.domElement.clientHeight)),.35,.7,.82);this.composer.addPass(this.bloom);this.fxaa=new ShaderPass(FXAAShader);this.composer.addPass(this.fxaa);this.outputPass=new OutputPass();this.composer.addPass(this.outputPass);}
  private disposeComposer(){this.renderPass?.dispose();this.bloom?.dispose();this.fxaa?.dispose();this.outputPass?.dispose();this.composer?.dispose();}
  private async restoreContext(){if(!this.contextLifecycle.beginRestore())return;this.renderer.domElement.dataset.contextState=this.contextLifecycle.state;this.contextStatus.textContent="Restoring graphics…";try{this.buildComposer();this.setQuality(this.quality);this.resize();this.scene.traverse(o=>{const mesh=o as THREE.Mesh;if(mesh.geometry){for(const attribute of Object.values(mesh.geometry.attributes))attribute.needsUpdate=true;}const materials=Array.isArray(mesh.material)?mesh.material:mesh.material?[mesh.material]:[];for(const material of materials){material.needsUpdate=true;const mapped=material as THREE.Material&{map?:THREE.Texture|null;roughnessMap?:THREE.Texture|null};if(mapped.map)mapped.map.needsUpdate=true;if(mapped.roughnessMap)mapped.roughnessMap.needsUpdate=true;}});this.renderer.info.reset();this.composer.render();this.contextLifecycle.restored();this.renderer.domElement.dataset.contextState=this.contextLifecycle.state;this.renderer.domElement.dataset.contextGeneration=String(this.contextLifecycle.generation);this.contextStatus.textContent="Graphics restored. Mission resumed.";setTimeout(()=>this.contextStatus.classList.add("hidden"),1800);}catch(error){this.contextLifecycle.fail(error);this.renderer.domElement.dataset.contextState=this.contextLifecycle.state;this.contextStatus.textContent=`Graphics recovery failed: ${this.contextLifecycle.error}. Use the pause menu to return safely.`;console.error("WebGL context recovery failed",error);}}

  setAIOrdersVisible(v: boolean) {
    this.aiOverlay.visible = v;
  }

  setLabelMode(mode: LabelMode) {
    this.labelMode = mode;
    for (const label of this.htmlLabels.values()) label.initialized = false;
  }

  setVisualDebug(on: boolean) {
    this.debugGroup.visible = on;
  }
  get sonarEffectsEnabled(){return this.graphics.sonarEffects;}
  testContextRecovery(){this.renderer.forceContextLoss();setTimeout(()=>this.renderer.forceContextRestore(),500);}

  /**
   * Planned-route / destination / label / link overlays for every unit.
   * Shows NEREUS's actual assignments: remaining path from the unit's current
   * position, path end marker, next-waypoint tick, and task links between
   * units or to known targets. Never references undiscovered threats.
   */
  private updateAIOverlays(alpha: number, elapsed: number, selectedId: string | null) {
    if (!this.aiOverlay.visible) return;
    const sim = this.sim;
    for (const u of sim.units) {
      const ov = this.unitOverlays.get(u.id)!;
      const px = u.prevPos.x + (u.pos.x - u.prevPos.x) * alpha;
      const py = u.prevPos.y + (u.pos.y - u.prevPos.y) * alpha;
      const pz = u.prevPos.z + (u.pos.z - u.prevPos.z) * alpha;
      const selected = u.id === selectedId;
      const dead = u.state === "destroyed";
      if (this.debugGroup.visible) {
        let debugDelta = u.heading - u.prevHeading;
        while (debugDelta > Math.PI) debugDelta -= Math.PI * 2;
        while (debugDelta < -Math.PI) debugDelta += Math.PI * 2;
        const heading = u.prevHeading + debugDelta * alpha;
        const debug = this.debugUnits.get(u.id)!;
        debug.bounds.position.set(px, py, pz); debug.bounds.rotation.set(Math.PI/2, heading, 0);
        const origin = new THREE.Vector3(px,py,pz);
        debug.forward.position.copy(origin); debug.forward.setDirection(new THREE.Vector3(Math.sin(heading),0,Math.cos(heading)));
        debug.command.position.copy(origin);
        const ch = u.cmdHeading ?? heading; debug.command.setDirection(new THREE.Vector3(Math.sin(ch),0,Math.cos(ch)));
      }

      // planned route: current position through remaining waypoints
      const path = u.task.path;
      const hasRoute = !dead && u.state === "active" && path.length > 0 && u.task.pathIndex < path.length;
      if (hasRoute) {
        const key = `${path.length}|${path[path.length - 1].x.toFixed(0)},${path[path.length - 1].z.toFixed(0)}|${u.task.pathIndex}`;
        if (key !== ov.routeKey) {
          ov.routeKey = key;
          const attr = ov.route.geometry.attributes.position as THREE.BufferAttribute;
          const pts = path.slice(u.task.pathIndex);
          const n = Math.min(pts.length + 1, 64);
          for (let i = 1; i < n; i++) attr.setXYZ(i, pts[i - 1].x, pts[i - 1].y, pts[i - 1].z);
          ov.route.geometry.setDrawRange(0, n);
          attr.needsUpdate = true;
        }
        // origin follows the interpolated unit position every frame
        const attr = ov.route.geometry.attributes.position as THREE.BufferAttribute;
        attr.setXYZ(0, px, py, pz);
        attr.needsUpdate = true;
        (ov.route.material as THREE.LineBasicMaterial).opacity = selected ? 0.9 : 0.3;
        ov.route.visible = true;
      } else {
        ov.route.visible = false;
        ov.routeKey = "";
      }

      // destination marker at the end of the assigned path
      const goal = hasRoute ? path[path.length - 1] : null;
      if (goal) {
        ov.dest.visible = true;
        ov.dest.position.set(goal.x, goal.y + 1.5, goal.z);
        const pulse = 1 + Math.sin(elapsed * 2.4) * 0.12;
        const assignedPulse = Math.max(0, 1 - (sim.now - u.task.committedAt) / 1.4);
        ov.dest.scale.setScalar((pulse + assignedPulse * .55) * (selected ? 1.6 : 1));
        (ov.dest.material as THREE.MeshBasicMaterial).opacity = selected ? 0.9 : 0.45;
      } else {
        ov.dest.visible = false;
      }

      // next-movement indicator: the waypoint being steered toward right now
      const wp = hasRoute ? path[u.task.pathIndex] : null;
      if (wp) {
        ov.tick.visible = true;
        ov.tick.position.set(wp.x, wp.y, wp.z);
        (ov.tick.material as THREE.MeshBasicMaterial).opacity = selected ? 0.95 : 0.5;
      } else {
        ov.tick.visible = false;
      }

      // task link: repair/escort connect to the ally; attack/jam/distract/
      // investigate connect to the (necessarily known) target point
      let linkTo: Vec3 | null = null;
      let linkColor = 0x6fe8a0;
      const t = u.task;
      if (!dead && (t.kind === "repair" || t.kind === "rescue" || t.kind === "escort") && t.targetId) {
        const target = sim.unit(t.targetId);
        if (target && target.state !== "destroyed") linkTo = target.pos;
        linkColor = t.kind === "escort" ? 0x7fd8e8 : 0x6fe8a0;
      } else if (!dead && (t.kind === "attack" || t.kind === "jam" || t.kind === "distract" || t.kind === "investigate") && t.pos) {
        linkTo = t.pos;
        linkColor = 0xffb347;
      } else if (!dead && t.kind === "transit" && t.corridorId === "narrow") {
        // The sequence is shown by the crisp screen-space label.
      }
      if (linkTo) {
        const attr = ov.link.geometry.attributes.position as THREE.BufferAttribute;
        attr.setXYZ(0, px, py, pz);
        attr.setXYZ(1, linkTo.x, linkTo.y, linkTo.z);
        attr.needsUpdate = true;
        const lm = ov.link.material as THREE.LineBasicMaterial;
        lm.color.setHex(linkColor);
        lm.opacity = (selected ? 0.85 : 0.4) * (0.7 + Math.sin(elapsed * 3) * 0.3);
        ov.link.visible = true;
      } else {
        ov.link.visible = false;
      }
    }
  }

  private buildTrialView(): TrialView {
    const spec = this.sim.mission.canyonTrial!;
    const group = new THREE.Group();
    group.name = "canyonTrial";
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x35434a, roughness: 0.92, metalness: 0.12 });
    const makeRock = (radius: number) => {
      const g = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(radius * (0.45 + (i % 3) * 0.12), 0), rockMat);
        const a = (i / 7) * Math.PI * 2;
        mesh.position.set(Math.cos(a) * radius * 0.58, (i % 2) * radius * 0.2, Math.sin(a) * radius * 0.5);
        mesh.rotation.set(i * 0.37, i * 0.61, i * 0.23);
        g.add(mesh);
      }
      return g;
    };
    for (const o of spec.barrier) {
      const rock = makeRock(o.radius * 0.55);
      rock.position.copy(o.pos as THREE.Vector3Like);
      group.add(rock);
    }
    const rockfall = makeRock(spec.rockfall.radius * 0.58);
    rockfall.position.copy(spec.rockfall.pos as THREE.Vector3Like);
    rockfall.visible = false;
    group.add(rockfall);
    const corridorLines = new Map<string, THREE.Line>();
    for (const corridor of spec.corridors) {
      const geo = new THREE.BufferGeometry().setFromPoints(corridor.points.map((p) => new THREE.Vector3(p.x, p.y + 3, p.z)));
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x7fd8e8, transparent: true, opacity: 0.24, dashSize: 24, gapSize: 16, depthWrite: false }));
      line.computeLineDistances();
      group.add(line);
      corridorLines.set(corridor.id, line);
    }
    const boundaryLines = new Map<string, THREE.LineLoop>();
    for (const o of [...spec.barrier, spec.rockfall]) {
      const pts = Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2;
        return new THREE.Vector3(o.pos.x + Math.cos(a) * o.radius, o.pos.y + 4, o.pos.z + Math.sin(a) * o.radius);
      });
      const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.5, depthWrite: false }));
      loop.visible = false;
      group.add(loop);
      boundaryLines.set(o.id, loop);
    }
    const regroup = new THREE.Mesh(
      new THREE.RingGeometry(70, 76, 48),
      new THREE.MeshBasicMaterial({ color: 0x6fe8a0, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })
    );
    regroup.rotation.x = -Math.PI / 2;
    regroup.position.copy(spec.regroupPoint as THREE.Vector3Like);
    group.add(regroup);
    this.scene.add(group);
    return { group, corridorLines, boundaryLines, rockfall, regroup, rockfallStartedAt: -1, rockfallSettled: false };
  }

  private updateTrialView(elapsed: number) {
    const view = this.trialView;
    const spec = this.sim.mission.canyonTrial;
    if (!view || !spec) return;
    const known = spec.barrier.some((o) => o.discovered);
    for (const corridor of spec.corridors) {
      const line = view.corridorLines.get(corridor.id)!;
      line.visible = known;
      const blocked = corridor.id === "narrow" && spec.rockfall.active && spec.rockfall.discovered;
      const mat = line.material as THREE.LineDashedMaterial;
      mat.color.setHex(blocked ? 0xff5340 : corridor.id === "narrow" ? 0xffb347 : 0x7fd8e8);
      mat.opacity = blocked ? 0.7 : 0.28;
    }
    for (const o of spec.barrier) view.boundaryLines.get(o.id)!.visible = o.discovered;
    if (spec.rockfall.active) {
      view.rockfall.position.copy(spec.rockfall.pos as THREE.Vector3Like);
      if (view.rockfallStartedAt < 0) view.rockfallStartedAt = elapsed;
      const t = Math.min(1, (elapsed - view.rockfallStartedAt) / 1.35);
      view.rockfall.visible = spec.rockfall.discovered;
      view.rockfall.position.y = spec.rockfall.pos.y + (1 - t) * 130;
      view.rockfall.rotation.x = (1 - t) * 1.6;
      view.rockfall.rotation.z = (1 - t) * -0.8;
      if (t >= 1 && !view.rockfallSettled) {
        view.rockfallSettled = true;
        this.effects.spawnImpact(spec.rockfall.pos, 2.3);
        if(this.graphics.sedimentEffects)this.effects.spawnSediment(spec.rockfall.pos,80);
      }
    } else {
      view.rockfall.visible = false;
      view.rockfallStartedAt = -1;
      view.rockfallSettled = false;
    }
    view.boundaryLines.get(spec.rockfall.id)!.visible = spec.rockfall.active && spec.rockfall.discovered;
    view.regroup.rotation.z = elapsed * 0.12;
    const s = 1 + Math.sin(elapsed * 2) * 0.04;
    view.regroup.scale.setScalar(s);
  }

  private updateHtmlLabels(alpha: number, dt: number, selectedId: string | null) {
    const rect = this.labelLayer.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return;
    const camera = this.rig.camera;
    camera.updateMatrixWorld();
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    for (const u of [...this.sim.units].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId))) {
      const label = this.htmlLabels.get(u.id)!;
      const selected = u.id === selectedId;
      const allowed = this.labelMode === "all" || (this.labelMode === "selected" && selected);
      if (!allowed || u.state === "destroyed") {
        label.root.hidden = true;
        continue;
      }
      const px = u.prevPos.x + (u.pos.x - u.prevPos.x) * alpha;
      const py = u.prevPos.y + (u.pos.y - u.prevPos.y) * alpha;
      const pz = u.prevPos.z + (u.pos.z - u.prevPos.z) * alpha;
      this.scratchAnchor.set(px, py + 19, pz);
      if (!selected && this.sim.mission.terrain.losBlocked(
        { x: camera.position.x, y: camera.position.y, z: camera.position.z },
        { x: this.scratchAnchor.x, y: this.scratchAnchor.y, z: this.scratchAnchor.z }
      )) {
        label.root.hidden = true;
        continue;
      }
      const view = this.scratchAnchor.clone().applyMatrix4(camera.matrixWorldInverse);
      if (view.z >= -camera.near || -view.z > camera.far) {
        label.root.hidden = true;
        continue;
      }
      this.scratchAnchor.project(camera);
      const offscreen = this.scratchAnchor.z < -1 || this.scratchAnchor.z > 1 || Math.abs(this.scratchAnchor.x) > 1.05 || Math.abs(this.scratchAnchor.y) > 1.05;
      if (offscreen && !selected) {
        label.root.hidden = true;
        continue;
      }
      let targetX = Math.max(54, Math.min(rect.width - 54, (this.scratchAnchor.x * 0.5 + 0.5) * rect.width));
      let targetY = Math.max(48, Math.min(rect.height - 74, (-this.scratchAnchor.y * 0.5 + 0.5) * rect.height));
      if (!selected) {
        for (const box of occupied) {
          if (Math.abs(targetX - box.x) < 96 && Math.abs(targetY - box.y) < 34) targetY = Math.min(rect.height - 74, box.y + 34);
        }
      }
      if (!label.initialized) {
        label.x = targetX; label.y = targetY; label.initialized = true;
      } else {
        const t = 1 - Math.exp(-(selected ? 18 : 12) * Math.min(dt, 0.1));
        label.x += (targetX - label.x) * t;
        label.y += (targetY - label.y) * t;
      }
      let action = shortTaskLabel(u, this.sim);
      if(u.control.mode==="manual") action="PLAYER CONTROLLED";
      else if(u.control.mode==="recovering") action="RETURNING TO NEREUS";
      else if (u.task.kind === "transit") {
        const plan = u.task.corridorId === "narrow" ? "Narrow Cut" : "Outer Passage";
        const sequence = this.sim.units.filter((x) => x.task.corridorId === "narrow").sort((a, b) => a.id.localeCompare(b.id)).findIndex((x) => x.id === u.id) + 1;
        action = `${plan} · Moving${sequence > 0 ? ` ${sequence}` : ""}`;
      } else {
        action = action.replace("→", " ");
      }
      label.task.textContent = action;
      label.root.hidden = false;
      label.root.classList.toggle("is-selected", selected);
      label.root.classList.toggle("is-disabled", u.state === "disabled");
      label.root.classList.toggle("is-edge", offscreen && selected);
      label.root.style.transform = `translate3d(${Math.round(label.x)}px, ${Math.round(label.y)}px, 0) translate(-50%, -100%)`;
      const distance = camera.position.distanceTo(this.scratchAnchor.set(px, py, pz));
      if(distance>this.graphics.labelDistance&&!selected){label.root.hidden=true;continue;}label.root.style.opacity = String(selected ? 1 : Math.max(0.46, Math.min(0.82, 1 - distance / this.graphics.labelDistance)));
      occupied.push({ x: label.x, y: label.y, w: 92, h: 28 });
    }
  }

  setQuality(q: Quality) {
    this.quality=q;if(q!=="custom")this.applyGraphics(GRAPHICS_PRESETS[q]);else this.applyGraphics(this.graphics);
  }
  setCustomQuality(settings:Partial<GraphicsSettings>){this.quality="custom";this.applyGraphics(validateGraphics(settings,this.graphics));}
  private applyGraphics(settings:GraphicsSettings){const previousAA=this.graphics.antiAliasing;this.graphics=validateGraphics(settings);if(previousAA!==this.graphics.antiAliasing&&this.contextLifecycle.available){this.disposeComposer();this.buildComposer();}const dpr=window.devicePixelRatio||1;this.renderer.setPixelRatio(Math.min(dpr,this.graphics.renderScale));this.composer.setPixelRatio(this.renderer.getPixelRatio());this.effects.quality=this.graphics.particles;this.snow.setDensity(this.graphics.particles);this.fish.setDensity(this.graphics.fish);this.bloom.enabled=this.graphics.postprocessing;this.bloom.strength=this.graphics.postprocessing?.28:0;this.fxaa.enabled=this.graphics.antiAliasing!=="off";this.renderer.shadowMap.enabled=this.graphics.shadows;this.sunLight.castShadow=this.graphics.shadows;this.sunLight.shadow.mapSize.set(this.graphics.shadows?2048:512,this.graphics.shadows?2048:512);setTerrainDetail(this.terrainMesh,this.graphics.terrainDetail);const threshold=this.graphics.modelDetail==="low"?.5:this.graphics.modelDetail==="medium"?.18:0;for(const v of this.unitViews.values()){v.model.group.visible=true;v.model.group.traverse(object=>{const mesh=object as THREE.Mesh;if(mesh.isMesh&&typeof mesh.userData.detailRadius==="number")mesh.visible=mesh.userData.detailRadius>=threshold||mesh===v.model.idLight;});v.model.headlight.visible=this.graphics.modelDetail!=="low";}this.resize();}

  resize() {
    const w = Math.max(1, this.renderer.domElement.clientWidth || window.innerWidth);
    const h = Math.max(1, this.renderer.domElement.clientHeight || window.innerHeight);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    const parentRect = this.renderer.domElement.parentElement!.getBoundingClientRect();
    this.labelLayer.style.left = `${canvasRect.left - parentRect.left}px`;
    this.labelLayer.style.top = `${canvasRect.top - parentRect.top}px`;
    this.labelLayer.style.width = `${canvasRect.width}px`;
    this.labelLayer.style.height = `${canvasRect.height}px`;
    for (const label of this.htmlLabels.values()) label.initialized = false;
  }

  /** per-frame sync from sim state */
  sync(alpha: number, dt: number, elapsed: number, selectedId: string | null, camMode: CameraMode) {
    const sim = this.sim;

    // fog follows camera depth; tactical view thins the fog for readability
    this.fogScaleTarget = camMode === "tactical" ? 0.12 : 1;
    this.atmosphere.update(this.rig.camera.position.y);
    this.atmosphere.fogDensityScale(this.fogScaleTarget, dt);
    this.fillLight.position.copy(this.rig.camera.position);

    // units
    for (const u of sim.units) {
      const view = this.unitViews.get(u.id)!;
      const g = view.model.group;
      const px = u.prevPos.x + (u.pos.x - u.prevPos.x) * alpha;
      const py = u.prevPos.y + (u.pos.y - u.prevPos.y) * alpha;
      const pz = u.prevPos.z + (u.pos.z - u.prevPos.z) * alpha;
      g.position.set(px, py, pz);
      let dh = u.heading - u.prevHeading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const heading = u.prevHeading + dh * alpha;
      const pitch = u.prevPitch + (u.pitch - u.prevPitch) * alpha;
      const bank = u.prevBank + (u.bank - u.prevBank) * alpha;
      g.rotation.set(0, 0, 0);
      g.rotateY(heading);
      g.rotateX(pitch);
      if (u.state === "destroyed") {
        view.destroyedTilt = Math.min(0.55, view.destroyedTilt + dt * 0.3);
      }
      g.rotateZ(bank + view.destroyedTilt);
      // Machinery animation from actual controller state.
      const roleSpin = u.role === "ATLAS" ? 1.25 : u.role === "GHOST" ? 2.7 : 2.1;
      const targetSpin = u.state === "active" ? u.speed * roleSpin : 0;
      view.propSpin += (targetSpin - view.propSpin) * (1 - Math.exp(-dt * 3));
      for (const p of view.model.propellers) p.rotation.z += view.propSpin * dt;
      const rudderTarget = THREE.MathUtils.clamp(u.turnCmd / Math.max(0.01, spec(u.role).turnRate), -1, 1) * 0.42;
      for (const r of view.model.rudders) r.rotation.y = THREE.MathUtils.damp(r.rotation.y, rudderTarget, 8, dt);
      const planeTarget = THREE.MathUtils.clamp(u.verticalSpeed / Math.max(0.01, spec(u.role).vertRate), -1, 1) * 0.32;
      for (const p of view.model.divePlanes) p.rotation.x = THREE.MathUtils.damp(p.rotation.x, -planeTarget, 7, dt);
      const sensorActive = sim.now < u.sonarActiveUntil || sim.now < u.jamUntil || u.task.kind === "survey" || u.task.kind === "scout" || u.task.desc?.includes("scanning");
      for (const s of view.model.sensors) s.rotation.y += sensorActive ? dt * (sim.now < u.sonarActiveUntil ? 2.4 : 0.45) : 0;
      const repairActive = u.role === "MENDER" && (u.task.kind === "repair" || u.task.kind === "recover" || u.task.kind === "fetchcore");
      view.model.repairArms.forEach((arm, i) => {
        const deploy = repairActive ? (i ? -0.58 : 0.58) : 0;
        arm.rotation.z = THREE.MathUtils.damp(arm.rotation.z, deploy, 6, dt);
        if (u.interactProgress > 0) arm.rotation.x = Math.sin(elapsed * 3.4 + i * Math.PI) * 0.08;
      });
      const recentShot = sim.projectiles.some((p) => p.fromNodeId === u.id && sim.now - p.launchedAt < 0.9);
      view.model.weaponDoors.forEach((door, i) => {
        const fired = spec(u.role).torpedoes - u.torpedoes;
        const open = recentShot && i === Math.max(0, fired - 1) % Math.max(1, view.model.weaponDoors.length);
        door.position.z += ((open ? 1.4 : 0) - (door.userData.slide ?? 0)) * Math.min(1, dt * 8);
        door.userData.slide = THREE.MathUtils.lerp(door.userData.slide ?? 0, open ? 1.4 : 0, Math.min(1, dt * 8));
      });
      // id light gentle pulse
      const idMat = view.model.idLight.material as THREE.MeshStandardMaterial;
      idMat.emissiveIntensity = u.state === "destroyed" ? 0 : 1.6 + Math.sin(elapsed * 2 + u.id.length) * 0.7;
      // damage bubbles
      if (u.state !== "destroyed" && u.hull < 55 && sim.now % 1 < 0.03) {
        this.effects.spawnBubbles(u.pos, 2, 0.8);
      }
      const speedRatio = u.speed / Math.max(1, spec(u.role).maxSpeed);
      view.trailAccumulator += u.speed * dt * (u.role === "GHOST" ? 0.04 : 0.09);
      if (u.state !== "destroyed" && speedRatio > 0.42 && view.trailAccumulator >= 1) {
        view.trailAccumulator -= 1;
        this.scratchAnchor.set(0, 0, -spec(u.role).length * 0.52).applyQuaternion(g.quaternion);
        this.effects.spawnBubbles(
          { x: px + this.scratchAnchor.x, y: py + this.scratchAnchor.y, z: pz + this.scratchAnchor.z },
          u.role === "ATLAS" ? 2 : 1,
          0.35 + speedRatio * 0.35
        );
      }
      const floor = sim.mission.terrain.seabedY(px, pz);
      const clearance = py - floor;
      view.sedimentAccumulator += clearance < 34 ? speedRatio * speedRatio * dt * this.effects.quality : 0;
      if (this.graphics.sedimentEffects&&view.sedimentAccumulator >= 0.45) {
        view.sedimentAccumulator -= 0.45;
        this.effects.spawnSediment({ x: px, y: floor + 2, z: pz }, Math.max(1, Math.round(spec(u.role).size * 2)));
      }
      // dim lights when dead
      if (u.state === "destroyed") view.model.headlight.visible = false;

      // tactical marker
      const sprite = this.tacticalSprites.get(u.id)!;
      sprite.visible = camMode === "tactical";
      if (sprite.visible) {
        sprite.position.set(px, py, pz);
        const h = Math.max(200, this.rig.camera.position.y);
        sprite.scale.setScalar(h * 0.045);
        const smat = sprite.material as THREE.SpriteMaterial;
        smat.color.setHex(u.state === "destroyed" ? 0x8a4038 : u.hasCore ? 0xffb347 : 0x7fd8e8);
        smat.opacity = u.state === "destroyed" ? 0.45 : 0.95;
      }
    }
    this.updateHtmlLabels(alpha, dt, selectedId);
    const manual=sim.manualOwnerId?sim.unit(sim.manualOwnerId):null;
    if(manual&&manual.control.mode==="manual"){
      const attr=this.manualProjection.geometry.attributes.position as THREE.BufferAttribute;let x=manual.pos.x,y=manual.pos.y,z=manual.pos.z,h=manual.heading,s=manual.speed;
      for(let i=0;i<20;i++){const t=.35;let dh=manual.control.command.heading-h;while(dh>Math.PI)dh-=Math.PI*2;while(dh<-Math.PI)dh+=Math.PI*2;h+=Math.max(-spec(manual.role).turnRate*t,Math.min(spec(manual.role).turnRate*t,dh));s+=Math.max(-spec(manual.role).accel*t,Math.min(spec(manual.role).accel*t,manual.control.command.throttle-s));x+=Math.sin(h)*s*t;z+=Math.cos(h)*s*t;y+=Math.max(-spec(manual.role).vertRate*t,Math.min(spec(manual.role).vertRate*t,-manual.control.command.depth-y));attr.setXYZ(i,x,y,z);}attr.needsUpdate=true;this.manualProjection.geometry.setDrawRange(0,20);this.manualProjection.visible=true;
    }else this.manualProjection.visible=false;

    // selection ring + path
    if (selectedId) {
      const u = sim.unit(selectedId);
      if (u && u.state !== "destroyed") {
        this.selectionRing.visible = true;
        this.selectionRing.position.set(u.prevPos.x + (u.pos.x - u.prevPos.x) * alpha, u.prevPos.y + (u.pos.y - u.prevPos.y) * alpha - 8, u.prevPos.z + (u.pos.z - u.prevPos.z) * alpha);
        const s = 1 + Math.sin(elapsed * 3) * 0.06;
        // scale up in tactical so the ring reads from altitude
        const ringScale = camMode === "tactical" ? Math.max(1, this.rig.camera.position.y / 180) : 1;
        this.selectionRing.scale.setScalar(s * ringScale);
        this.updatePathLine(u);
        if (sim.canyonTrial) {
          this.clearanceRing.visible = true;
          this.clearanceRing.position.copy(this.selectionRing.position);
          const required = spec(u.role).radius + sim.canyonTrial.clearanceMargin;
          this.clearanceRing.scale.setScalar(required);
        } else {
          this.clearanceRing.visible = false;
        }
      } else {
        this.selectionRing.visible = false;
        this.pathLine.visible = false;
        this.clearanceRing.visible = false;
      }
    } else {
      this.selectionRing.visible = false;
      this.pathLine.visible = false;
      this.clearanceRing.visible = false;
    }

    // nodes & their radius discs follow contact knowledge
    for (const n of sim.nodes) {
      const v = this.nodeViews.get(n.id)!;
      const contact = sim.contacts.get(`c-${n.id}`);
      const known = !!contact || n.state === "alert";
      v.group.visible = known;
      v.radius.visible = known && n.state !== "disabled" && n.state !== "destroyed" && camMode !== "cinematic";
      if (known) {
        const mat = v.ring.material as THREE.MeshStandardMaterial;
        mat.emissive.setHex(NODE_STATE_COLORS[n.state] ?? 0x6fe8a0);
        mat.emissiveIntensity = n.state === "alert" ? 2.5 + Math.sin(elapsed * 8) * 1.5 : 1.6;
        (v.radius.material as THREE.MeshBasicMaterial).color.setHex(
          n.state === "alert" ? 0xff5340 : 0xffb347
        );
        (v.radius.material as THREE.MeshBasicMaterial).opacity = n.state === "alert" ? 0.16 : 0.08;
        v.head.rotation.y = elapsed * (n.state === "alert" ? 2.2 : 0.5);
      }
    }

    // mines
    if(sim.minefield){
      for(const [id,v] of this.minefieldContactViews){const c=sim.minefield.contacts.get(id);if(!c){v.ring.visible=false;v.marker.visible=false;continue;}v.ring.visible=true;v.ring.position.set(c.estimate.x,c.estimate.y+2,c.estimate.z);v.ring.scale.setScalar(Math.max(8,c.uncertainty));const color=c.classification==="decoy"?0x6fe8a0:c.classification==="mine"?0xff5340:c.classification==="disabled"?0x56666a:0xffb347;(v.ring.material as THREE.LineDashedMaterial).color.setHex(color);v.marker.visible=["mine","decoy","disabled"].includes(c.classification);v.marker.position.copy(v.ring.position);(v.marker.material as THREE.MeshBasicMaterial).color.setHex(color);v.marker.rotation.y=elapsed*.35;}
    }
    for (const m of sim.mines) {
      const v = this.mineViews.get(m.id)!;
      const contact = sim.minefield?.contacts.get(m.id)??sim.contacts.get(`c-${m.id}`);
      v.visible = !!contact && contact.classification==="mine" && !m.detonated;
      if(contact&&"estimate" in contact)v.position.copy(contact.estimate as THREE.Vector3Like);
    }
    if(sim.echoRidge){for(const[id,g]of this.hostileViews){const contact=sim.echoRidge.contacts.get(id),truth=sim.hostileDrones.find(d=>d.id===id);g.visible=!!contact&&!!truth;if(contact&&truth){g.position.copy(contact.estimate as THREE.Vector3Like);g.rotation.y=contact.heading;}}}

    // projectiles
    for (const p of sim.projectiles) {
      if (p.done) continue;
      let mesh = this.projViews.get(p.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.8, 6, 4, 8),
          new THREE.MeshStandardMaterial({
            color: 0x222222,
            emissive: new THREE.Color(0xffb347),
            emissiveIntensity: 1.8
          })
        );
        this.scene.add(mesh);
        this.projViews.set(p.id, mesh);
      }
      const px = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha;
      const py = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
      const pz = p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha;
      mesh.position.set(px, py, pz);
      mesh.lookAt(px + p.vel.x, py + p.vel.y, pz + p.vel.z);
      mesh.rotateX(Math.PI / 2);
      if (Math.random() < 0.3) this.effects.spawnBubbles({ x: px, y: py, z: pz }, 1, 0.5);
    }
    // cleanup finished projectiles
    for (const [id, mesh] of this.projViews) {
      const p = sim.projectiles.find((x) => x.id === id);
      if (!p || p.done) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.projViews.delete(id);
      }
    }

    // objective markers pulse; hide completed
    for (const o of sim.objectives) {
      const m = this.objMarkers.get(o.id);
      if (!m) continue;
      m.visible = !o.done && (o.kind !== "facility" || sim.facilityRevealed);
      m.rotation.y = elapsed * 0.8;
      m.position.y = o.pos.y + Math.sin(elapsed * 1.4) * 2;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 1.3 + Math.sin(elapsed * 2.2) * 0.6;
    }

    // dropped core beacon
    if (sim.coreState === "dropped" && sim.corePos) {
      this.coreBeacon.visible = true;
      this.coreBeacon.position.set(sim.corePos.x, sim.corePos.y + 4, sim.corePos.z);
      this.coreBeacon.rotation.y = elapsed * 1.5;
    } else {
      this.coreBeacon.visible = false;
    }

    // facility beacon pulse
    const beacon = this.scene.getObjectByName("facilityBeacon");
    if (beacon) {
      const bm = (beacon as THREE.Mesh).material as THREE.MeshStandardMaterial;
      bm.emissiveIntensity = 1.6 + Math.sin(elapsed * 3.2) * 1.2;
    }
    const beaconColumn = this.scene.getObjectByName("facilityBeaconColumn");
    if (beaconColumn) {
      beaconColumn.visible = sim.facilityRevealed && sim.coreState === "atFacility";
      const bm = (beaconColumn as THREE.Mesh).material as THREE.MeshBasicMaterial;
      bm.opacity = 0.07 + Math.sin(elapsed * 2) * 0.025;
    }

    // AI order overlays (routes, destinations, labels, links)
    this.updateAIOverlays(alpha, elapsed, selectedId);
    this.updateTrialView(elapsed);

    // vent bubbles
    if (Math.random() < dt * 2) {
      const v = sim.mission.vents[Math.floor(Math.random() * sim.mission.vents.length)];
      if (v) this.effects.spawnBubbles({ x: v.pos.x, y: v.pos.y + 8, z: v.pos.z }, 3, 1.2);
    }

    // atmosphere animation
    this.snow.update(dt, this.rig.camera.position);
    this.fish.update(elapsed, this.rig.camera.position, sim.units.map((u) => ({ pos: u.pos, speed: u.speed })));
    this.shafts.update(elapsed, this.rig.camera.position.y);
    this.caustics.update(elapsed, this.rig.camera.position.y);
    this.effects.update(dt);
  }

  private updatePathLine(u: Unit) {
    const path = u.task.path;
    if (!path || path.length === 0 || u.state !== "active") {
      this.pathLine.visible = false;
      this.lastPathKey = "";
      return;
    }
    const keyNow = `${u.id}|${path.length}|${path[path.length - 1].x.toFixed(0)},${path[path.length - 1].z.toFixed(0)}|${u.task.pathIndex}`;
    if (keyNow === this.lastPathKey) {
      this.pathLine.visible = true;
      return;
    }
    this.lastPathKey = keyNow;
    const attr = this.pathLine.geometry.attributes.position as THREE.BufferAttribute;
    const pts = [u.pos, ...path.slice(u.task.pathIndex)];
    const n = Math.min(pts.length, 64);
    for (let i = 0; i < n; i++) {
      attr.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
    }
    this.pathLine.geometry.setDrawRange(0, n);
    attr.needsUpdate = true;
    this.pathLine.visible = true;
  }

  render() {
    if (!this.contextLifecycle.available) return;
    this.renderer.info.reset();
    this.composer.render();
  }

  /** raycast pick: returns unit id or terrain point */
  pick(nx: number, ny: number): { unitId: string | null; point: Vec3 | null } {
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.rig.camera);
    // units first
    const unitObjs: THREE.Object3D[] = [];
    for (const [id, v] of this.unitViews) {
      if (v.model.group.visible) {
        v.model.group.userData.unitId = id;
        unitObjs.push(v.model.group);
      }
    }
    const unitHits = this.raycaster.intersectObjects(unitObjs, true);
    if (unitHits.length > 0) {
      let o: THREE.Object3D | null = unitHits[0].object;
      while (o && !o.userData.unitId) o = o.parent;
      if (o?.userData.unitId) return { unitId: o.userData.unitId as string, point: null };
    }
    // terrain
    const tHits = this.raycaster.intersectObject(this.terrainMesh, false);
    if (tHits.length > 0) {
      const p = tHits[0].point;
      if (Math.abs(p.x) > WORLD.HALF || Math.abs(p.z) > WORLD.HALF) {
        return { unitId: null, point: null };
      }
      return { unitId: null, point: { x: p.x, y: p.y - 30, z: p.z } };
    }
    return { unitId: null, point: null };
  }

  dispose() {
    this.resizeObserver?.disconnect();
    this.renderer.domElement.removeEventListener("webglcontextlost",this.onContextLost);this.renderer.domElement.removeEventListener("webglcontextrestored",this.onContextRestored);this.contextStatus.remove();
    this.labelLayer.remove();
    this.htmlLabels.clear();
    this.effects.dispose();
    this.disposeComposer();
    this.renderer.dispose();
    this.scene.traverse((o) => {
      const renderable = o as THREE.Mesh | THREE.Points | THREE.Sprite;
      if (!(renderable as THREE.Mesh).isMesh && !(renderable as THREE.Points).isPoints && !(renderable as THREE.Sprite).isSprite) return;
      (renderable as THREE.Mesh | THREE.Points).geometry?.dispose();
      const source = renderable.material;
      const mats = Array.isArray(source) ? source : [source];
      for (const mat of mats) {
        const mapped = mat as THREE.Material & { map?: THREE.Texture | null; roughnessMap?: THREE.Texture | null };
        mapped.map?.dispose();
        mapped.roughnessMap?.dispose();
        mapped.dispose();
      }
    });
    this.tacticalSpriteTex.dispose();
  }
}
