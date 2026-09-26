import { Rng } from "../rng";
import { AbyssalCrownSpec, CanyonTrialSpec, EchoRidgeSpec, Mine, MissionMode, Objective, SecurityNode, SilentDivideSpec, SilentMinefieldSpec, Vec3, vec3 } from "../types";
import { Terrain } from "./terrain";
import { WORLD } from "../config";

export interface Scatter {
  pos: Vec3;
  rot: number;
  scale: number;
}

export interface MissionSpec {
  mode: MissionMode;
  seed: number;
  terrain: Terrain;
  objectives: Objective[];
  nodes: SecurityNode[];
  mines: Mine[];
  wrecks: Scatter[];
  rocks: Scatter[];
  vents: Scatter[];
  deployment: Vec3[];
  facilityPos: Vec3;
  extractionPos: Vec3;
  surveyA: Vec3;
  surveyB: Vec3;
  canyonTrial?: CanyonTrialSpec;
  silentMinefield?: SilentMinefieldSpec;
  echoRidge?: EchoRidgeSpec;
  silentDivide?: SilentDivideSpec;
  abyssalCrown?: AbyssalCrownSpec;
}

function floorY(terrain: Terrain, x: number, z: number, clearance: number): number {
  return -terrain.depthAt(x, z) + clearance;
}

/** BFS over the clearance grid — used to prove a navigable route exists. */
export function routeExists(terrain: Terrain, from: Vec3, to: Vec3, minColumn = 42): boolean {
  const H = WORLD.HALF;
  const cell = 40;
  const n = Math.floor((2 * H) / cell);
  const idx = (ix: number, iz: number) => iz * n + ix;
  const toCell = (v: number) => Math.max(0, Math.min(n - 1, Math.floor((v + H) / cell)));
  const pass = new Uint8Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -H + (ix + 0.5) * cell;
      const z = -H + (iz + 0.5) * cell;
      pass[idx(ix, iz)] = terrain.depthAt(x, z) >= minColumn ? 1 : 0;
    }
  }
  const start = idx(toCell(from.x), toCell(from.z));
  const goal = idx(toCell(to.x), toCell(to.z));
  if (!pass[start] || !pass[goal]) return false;
  const seen = new Uint8Array(n * n);
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const c = q.pop()!;
    if (c === goal) return true;
    const cx = c % n;
    const cz = Math.floor(c / n);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = idx(nx, nz);
        if (!seen[ni] && pass[ni]) {
          seen[ni] = 1;
          q.push(ni);
        }
      }
    }
  }
  return false;
}

export function generateMission(seed: number, difficulty: "easy" | "normal" | "hard"): MissionSpec {
  const rng = new Rng(seed ^ 0x51ab);
  const terrain = new Terrain(seed);
  const j = (v: number, amt: number) => v + rng.range(-amt, amt);

  // --- Structural layout (fixed anchors + seeded jitter) -----------------
  const basin = { x: j(-1080, 40), z: j(60, 40) };
  terrain.basins.push({ x: basin.x, z: basin.z, r: 260, depth: 195 });

  const facility = { x: j(940, 30), z: j(0, 30) };
  terrain.basins.push({ x: facility.x, z: facility.z, r: 280, depth: 300 });

  const extraction = { x: j(1150, 25), z: j(-700, 30) };
  terrain.basins.push({ x: extraction.x, z: extraction.z, r: 180, depth: 230 });

  const northCanyon = [
    { x: basin.x + 140, z: basin.z - 60 },
    { x: j(-520, 40), z: j(-270, 30) },
    { x: j(-100, 50), z: j(-390, 25) },
    { x: j(340, 40), z: j(-330, 30) },
    { x: j(690, 30), z: j(-160, 25) },
    { x: facility.x - 60, z: facility.z - 40 }
  ];
  const southCanyon = [
    { x: basin.x + 150, z: basin.z + 90 },
    { x: j(-470, 40), z: j(390, 30) },
    { x: j(-50, 50), z: j(480, 25) },
    { x: j(390, 40), z: j(430, 30) },
    { x: j(710, 30), z: j(210, 25) },
    { x: facility.x - 40, z: facility.z + 60 }
  ];
  const escortCanyon = [
    { x: facility.x + 50, z: facility.z - 90 },
    { x: j(1090, 25), z: j(-380, 30) },
    { x: extraction.x - 10, z: extraction.z + 60 }
  ];
  terrain.canyons.push(
    { pts: northCanyon, inner: 85, outer: 195, floorDepth: 265 },
    { pts: southCanyon, inner: 85, outer: 195, floorDepth: 278 },
    { pts: escortCanyon, inner: 80, outer: 175, floorDepth: 250 }
  );

  // --- Objectives ---------------------------------------------------------
  const mkObj = (id: string, kind: Objective["kind"], x: number, z: number, label: string, clear: number): Objective => ({
    id,
    kind,
    pos: vec3(x, floorY(terrain, x, z, clear), z),
    label,
    done: false,
    progress: 0
  });
  const surveyA = mkObj("surveyA", "surveyA", northCanyon[2].x, northCanyon[2].z, "Survey north canyon route", 60);
  const surveyB = mkObj("surveyB", "surveyB", southCanyon[2].x, southCanyon[2].z, "Survey south canyon route", 60);
  const facilityObj = mkObj("facility", "facility", facility.x, facility.z, "Recover the data core", 40);
  const extractionObj = mkObj("extraction", "extraction", extraction.x, extraction.z, "Extraction zone", 60);

  // --- Security nodes ------------------------------------------------------
  const nodePositions = [
    { x: northCanyon[4].x + 20, z: northCanyon[4].z - 30 },
    { x: southCanyon[4].x + 20, z: southCanyon[4].z + 20 },
    { x: facility.x + 130, z: facility.z - 70 },
    { x: escortCanyon[1].x, z: escortCanyon[1].z }
  ];
  if (difficulty === "hard") nodePositions.push({ x: extraction.x - 60, z: extraction.z + 130 });
  const nodes: SecurityNode[] = nodePositions.map((p, i) => ({
    id: `node${i}`,
    pos: vec3(j(p.x, 25), 0, j(p.z, 25)),
    state: "dormant",
    detectRadius: 330,
    suspicion: 0,
    suspicionTarget: null,
    cooldownUntil: 0,
    fireCooldownUntil: 0,
    hp: difficulty === "easy" ? 2 : difficulty === "normal" ? 3 : 4,
    jammedUntil: 0
  }));
  for (const n of nodes) n.pos.y = floorY(terrain, n.pos.x, n.pos.z, 10);

  // --- Mines ---------------------------------------------------------------
  const mines: Mine[] = [];
  const mineClusters = [
    { x: facility.x - 180, z: facility.z + 150, r: 130, count: difficulty === "easy" ? 7 : 10 },
    { x: northCanyon[3].x + 60, z: northCanyon[3].z + 40, r: 90, count: difficulty === "hard" ? 5 : 3 }
  ];
  let mineId = 0;
  for (const c of mineClusters) {
    let placed = 0;
    let guard = 0;
    while (placed < c.count && guard++ < 200) {
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * c.r;
      const x = c.x + Math.cos(a) * r;
      const z = c.z + Math.sin(a) * r;
      if (mines.some((m) => Math.hypot(m.pos.x - x, m.pos.z - z) < 42)) continue;
      mines.push({
        id: `mine${mineId++}`,
        pos: vec3(x, floorY(terrain, x, z, rng.range(14, 30)), z),
        armed: true,
        detonated: false,
        triggerRadius: 34,
        damageRadius: 85
      });
      placed++;
    }
  }

  // --- Scenery -------------------------------------------------------------
  const wrecks: Scatter[] = [];
  const wreckField = { x: southCanyon[3].x - 200, z: southCanyon[3].z + 30 };
  for (let i = 0; i < 7; i++) {
    const x = j(wreckField.x, 150);
    const z = j(wreckField.z, 120);
    wrecks.push({ pos: vec3(x, floorY(terrain, x, z, 2), z), rot: rng.range(0, Math.PI * 2), scale: rng.range(0.7, 1.5) });
  }

  const rocks: Scatter[] = [];
  for (let i = 0; i < 90; i++) {
    const x = rng.range(-WORLD.HALF + 100, WORLD.HALF - 100);
    const z = rng.range(-WORLD.HALF + 100, WORLD.HALF - 100);
    const depth = terrain.depthAt(x, z);
    if (depth < 60) continue; // not on the shallow rim
    rocks.push({
      pos: vec3(x, floorY(terrain, x, z, -2), z),
      rot: rng.range(0, Math.PI * 2),
      scale: rng.range(0.5, 3.2)
    });
  }

  const vents: Scatter[] = [];
  for (let i = 0; i < 9; i++) {
    const src = rng.pick([northCanyon[2], southCanyon[3], { x: facility.x, z: facility.z }]);
    const x = j(src.x, 120);
    const z = j(src.z, 120);
    vents.push({ pos: vec3(x, floorY(terrain, x, z, 0), z), rot: 0, scale: rng.range(0.8, 1.6) });
  }

  // --- Deployment ----------------------------------------------------------
  const deployment: Vec3[] = [];
  const formation = [
    { dx: 0, dz: 0 },
    { dx: -70, dz: -60 },
    { dx: -70, dz: 60 },
    { dx: -150, dz: -110 },
    { dx: -150, dz: 110 }
  ];
  for (const f of formation) {
    const x = basin.x + f.dx;
    const z = basin.z + f.dz;
    deployment.push(vec3(x, -Math.min(150, terrain.depthAt(x, z) - 20), z));
  }

  return {
    mode: "mission",
    seed,
    terrain,
    objectives: [surveyA, surveyB, facilityObj, extractionObj],
    nodes,
    mines,
    wrecks,
    rocks,
    vents,
    deployment,
    facilityPos: facilityObj.pos,
    extractionPos: extractionObj.pos,
    surveyA: surveyA.pos,
    surveyB: surveyB.pos
  };
}

/** Deterministic training ground for centralized obstacle coordination. */
export function generateCanyonPassageTrial(seed: number): MissionSpec {
  const terrain = new Terrain(seed ^ 0xca77);
  const y = -120;
  const startX = -920;
  const destination = vec3(900, y, 0);
  const regroupPoint = vec3(760, y, 0);
  terrain.basins.push({ x: 0, z: 0, r: 1250, depth: 230 });
  terrain.canyons.push(
    { pts: [{ x: startX, z: 0 }, { x: 0, z: -220 }, { x: destination.x, z: 0 }], inner: 95, outer: 210, floorDepth: 230 },
    { pts: [{ x: startX, z: 0 }, { x: -80, z: 470 }, { x: destination.x, z: 0 }], inner: 170, outer: 290, floorDepth: 230 }
  );
  const deployment = [
    vec3(startX, y, 0),
    vec3(startX - 75, y, -80),
    vec3(startX - 75, y, 80),
    vec3(startX - 160, y, -145),
    vec3(startX - 160, y, 145)
  ];
  const stagingSlots = [
    vec3(-650, y, 0), vec3(-730, y, -90), vec3(-730, y, 90), vec3(-825, y, -160), vec3(-825, y, 160)
  ];
  const narrow = [vec3(-600, y, 0), vec3(-240, y, -210), vec3(130, y, -210), vec3(500, y, -80), regroupPoint];
  const outer = [vec3(-600, y, 0), vec3(-350, y, 360), vec3(100, y, 500), vec3(530, y, 300), regroupPoint];
  const barrier = [
    { id: "wall-nw", pos: vec3(-430, y, 80), radius: 145, discovered: false, active: true },
    { id: "wall-mid", pos: vec3(140, y, 20), radius: 205, discovered: false, active: true },
    { id: "wall-se", pos: vec3(420, y, 100), radius: 150, discovered: false, active: true }
  ];
  const canyonTrial: CanyonTrialSpec = {
    destination,
    regroupPoint,
    stagingSlots,
    corridors: [
      { id: "narrow", name: "Narrow Cut", width: 23, points: narrow },
      { id: "outer", name: "Outer Passage", width: 70, points: outer }
    ],
    barrier,
    rockfall: { id: "rockfall", pos: vec3(-30, y, -205), radius: 74, discovered: false, active: false }
  };
  const objective: Objective = { id: "trial-destination", kind: "extraction", pos: destination, label: "Regroup beyond Canyon Passage", done: false, progress: 0 };
  return {
    mode: "canyonTrial",
    seed,
    terrain,
    objectives: [objective],
    nodes: [],
    mines: [],
    wrecks: [],
    rocks: [],
    vents: [],
    deployment,
    facilityPos: destination,
    extractionPos: destination,
    surveyA: destination,
    surveyB: destination,
    canyonTrial
  };
}

export function generateSilentMinefieldTrial(seed: number): MissionSpec {
  const terrain = new Terrain(seed ^ 0x51e17);
  const rng = new Rng(seed ^ 0x4d1e);
  const y = -120;
  terrain.basins.push({ x: 0, z: 0, r: 1250, depth: 235 });
  const deployment = [vec3(-1000,y,0),vec3(-1070,y,-75),vec3(-1070,y,75),vec3(-1145,y,-135),vec3(-1145,y,135)];
  const destination=vec3(980,y,0), regroupPoint=vec3(820,y,0);
  const alpha=[vec3(-700,y,-190),vec3(-250,y,-300),vec3(260,y,-260),vec3(650,y,-120),regroupPoint];
  const bravo=[vec3(-700,y,220),vec3(-300,y,470),vec3(220,y,500),vec3(650,y,260),regroupPoint];
  const contacts: SilentMinefieldSpec["contacts"] = [];
  for(let i=0;i<15;i++){
    const corridorId = i<8 ? "alpha" as const : null;
    const route = i<8?alpha:bravo;
    const p=route[Math.min(route.length-2,1+(i%3))];
    contacts.push({id:`M-${String(i+1).padStart(2,"0")}`,pos:vec3(p.x+rng.range(-150,150),y+rng.range(-18,18),p.z+rng.range(-120,120)),isMine:i!==3&&i!==10&&i!==13,drifting:false,velocity:vec3(),corridorId});
  }
  const mines:Mine[]=contacts.filter(c=>c.isMine).map(c=>({id:c.id,pos:{...c.pos},armed:true,detonated:false,triggerRadius:34,damageRadius:90}));
  const stagingSlots=[vec3(-700,y,0),vec3(-770,y,-75),vec3(-770,y,75),vec3(-850,y,-135),vec3(-850,y,135)];
  const objective:Objective={id:"minefield-destination",kind:"extraction",pos:destination,label:"Cross and regroup beyond Silent Minefield",done:false,progress:0};
  return {mode:"silentMinefield",seed,terrain,objectives:[objective],nodes:[],mines,wrecks:[],rocks:[],vents:[],deployment,facilityPos:destination,extractionPos:destination,surveyA:destination,surveyB:destination,silentMinefield:{destination,regroupPoint,stagingSlots,corridors:[{id:"alpha",name:"Corridor Alpha",width:62,points:alpha},{id:"bravo",name:"Corridor Bravo",width:90,points:bravo}],contacts}};
}

export function generateEchoRidgeScenario(seed:number):MissionSpec{
  const terrain=new Terrain(seed^0xec40),y=-130;terrain.basins.push({x:0,z:0,r:1300,depth:270});
  const deployment=[vec3(-1050,y,0),vec3(-1120,y,-80),vec3(-1120,y,80),vec3(-1200,y,-140),vec3(-1200,y,140)];
  const station=vec3(80,y,-80),extraction=vec3(1050,y,420);terrain.canyons.push({pts:[{x:-1050,z:0},{x:-400,z:-220},{x:80,z:-80},{x:520,z:180},{x:1050,z:420}],inner:130,outer:280,floorDepth:260},{pts:[{x:-400,z:-220},{x:0,z:380},{x:520,z:180}],inner:110,outer:240,floorDepth:285});
  const objective:Objective={id:"sensor-package",kind:"facility",pos:station,label:"Recover Echo Ridge sensor package",done:false,progress:0};
  const echoRidge:EchoRidgeSpec={station,packagePos:{...station},extraction,fallbackPoints:[vec3(-300,y,360),vec3(380,y,420)],reinforcementSpawn:vec3(1250,y,-900),droneSpawns:[{id:"H-01",role:"recon",pos:vec3(-50,y,-760),heading:0},{id:"H-02",role:"pursuit",pos:vec3(480,y,-620),heading:-1},{id:"H-03",role:"attack",pos:vec3(850,y,-300),heading:-1.5}]};
  return{mode:"echoRidge",seed,terrain,objectives:[objective],nodes:[],mines:[],wrecks:[],rocks:[],vents:[],deployment,facilityPos:station,extractionPos:extraction,surveyA:station,surveyB:extraction,echoRidge};
}
export function generateSilentDivideScenario(seed:number):MissionSpec{const terrain=new Terrain(seed^0xd1f1),y=-125;terrain.basins.push({x:0,z:0,r:1300,depth:245});const deployment=[vec3(-1100,y,0),vec3(-1170,y,-75),vec3(-1170,y,75),vec3(-1240,y,-130),vec3(-1240,y,130)],station=vec3(200,y,-80),extraction=vec3(1080,y,520);const reliable=[vec3(-850,y,260),vec3(-350,y,540),vec3(260,y,620),vec3(720,y,570),extraction],divide=[vec3(-850,y,-80),vec3(-300,y,-120),station,vec3(650,y,180),extraction],relaySites=[vec3(-650,y,220),vec3(-300,y,360),vec3(100,y,450)];terrain.canyons.push({pts:reliable.map(p=>({x:p.x,z:p.z})),inner:150,outer:290,floorDepth:245},{pts:divide.map(p=>({x:p.x,z:p.z})),inner:90,outer:210,floorDepth:260});const objective:Objective={id:"black-box",kind:"facility",pos:station,label:"Recover Silent Divide black box",done:false,progress:0};const silentDivide:SilentDivideSpec={station,blackBoxPos:{...station},extraction,relaySites,jammerPos:vec3(350,y,-180),deadZoneCenter:vec3(80,y,-100),deadZoneRadius:390,routes:[{id:"reliable",name:"Relay Arc",points:reliable},{id:"divide",name:"Silent Divide",points:divide}]};return{mode:"silentDivide",seed,terrain,objectives:[objective],nodes:[],mines:[],wrecks:[],rocks:[],vents:[],deployment,facilityPos:station,extractionPos:extraction,surveyA:station,surveyB:extraction,silentDivide};}

export function generateAbyssalCrownScenario(seed:number,difficulty:"easy"|"normal"|"hard"="normal"):MissionSpec{const terrain=new Terrain(seed^0xac00),rng=new Rng(seed^0xc0a1),y=-130;terrain.basins.push({x:0,z:0,r:1380,depth:280});const deployment=[vec3(-1250,y,0),vec3(-1310,y,-70),vec3(-1310,y,70),vec3(-1370,y,-125),vec3(-1370,y,125)],insertion=vec3(-1080,y,0),canyon=vec3(-650,y,0),network=vec3(-260,y,140),minefield=vec3(180,y,100),defense=vec3(550,y,40),facility=vec3(820,y,70),primaryExtraction=vec3(1220,y,330),alternateExtraction=vec3(1100,y,-430);const safeRoute=[insertion,vec3(-930,y,250),vec3(-700,y,300),canyon],shortRoute=[insertion,vec3(-900,y,-100),vec3(-720,y,-90),canyon],mineSafe=[network,vec3(-80,y,360),vec3(260,y,360),defense],mineShort=[network,vec3(-40,y,50),vec3(260,y,40),defense];terrain.canyons.push({pts:safeRoute.map(p=>({x:p.x,z:p.z})),inner:150,outer:290,floorDepth:260},{pts:shortRoute.map(p=>({x:p.x,z:p.z})),inner:80,outer:185,floorDepth:245},{pts:mineSafe.map(p=>({x:p.x,z:p.z})),inner:140,outer:270,floorDepth:270},{pts:[{x:defense.x,z:defense.z},{x:facility.x,z:facility.z},{x:primaryExtraction.x,z:primaryExtraction.z}],inner:130,outer:260,floorDepth:275});const mines:Mine[]=Array.from({length:10},(_,i)=>{const p=mineShort[1+i%2];return{id:`crown-mine-${i}`,pos:vec3(p.x+rng.range(-130,130),y+rng.range(-15,15),p.z+rng.range(-100,100)),armed:true,detonated:false,triggerRadius:34,damageRadius:88};});const objective:Objective={id:"crown-core",kind:"facility",pos:facility,label:"Recover the Abyssal Crown data core",done:false,progress:0};const deadline=difficulty==="easy"?1800:difficulty==="hard"?1250:1500,abyssalCrown:AbyssalCrownSpec={checkpoints:{insertion,canyon,network,minefield,defense,core:facility,extraction:primaryExtraction},safeRoute,shortRoute,mineRoutes:{safe:mineSafe,short:mineShort},primaryExtraction,alternateExtraction,relaySite:vec3(-430,y,220),facility,deadline,encounterAt:{jammer:300,drift:560,hostile:720,lateBlock:1120}};return{mode:"abyssalCrown",seed,terrain,objectives:[objective],nodes:[],mines,wrecks:[],rocks:[],vents:[],deployment,facilityPos:facility,extractionPos:primaryExtraction,surveyA:canyon,surveyB:defense,abyssalCrown};}
