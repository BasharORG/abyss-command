import { DIFFICULTIES, Doctrine } from "../types";
import { DOCTRINE } from "../config";
import { Quality } from "../render/worldview";
import { GraphicsSettings, GRAPHICS_PRESETS, validateGraphics } from "../render/graphicsSettings";
import { Nereus } from "../ai/nereus";
import { Simulation } from "../sim/simulation";
import { CampaignState, CAMPAIGN_OPERATIONS, operationAvailable } from "../logistics/campaign";
import { ACTIONS, Bindings, defaultBindings } from "../input/actions";
import { FocusTrap } from "./focusTrap";

export interface MenuCallbacks {
  onStart(seed: string, difficulty: "easy" | "normal" | "hard"): void;
  onDeploy(doctrine: Doctrine,preparation:{emphasis:"balanced"|"endurance"|"mission";reserve:number;authorize:boolean}): void;
  onResume(): void;
  onRestart(sameSeed: boolean): void;
  onQuitToMenu(): void;
  onQuality(q: Quality): void;
  onVolume(kind: "master" | "effects" | "music", v: number): void;
  onReducedMotion(on: boolean): void;
  onCustomGraphics(settings:GraphicsSettings):void;
  onNewCampaign():void;
  onContinueCampaign(id:string):void;
  onCampaignOperation(id:string):void;
  onServiceCampaign():void;
  onStorageRetry():void;
  onStorageExport():void;
  onStorageDelete():void;
}

export interface Settings {
  quality: Quality;
  master: number;
  effects: number;
  music: number;
  reducedMotion: boolean;
  textScale:number;
  highContrast:boolean;
  pauseOnBlur:boolean;
  subtitles:boolean;
  cameraShake:boolean;
  bindings:Bindings;performanceDisplay:boolean;graphics:GraphicsSettings;
}

export class Menus {
  private root: HTMLElement;
  private cb: MenuCallbacks;
  settings: Settings = { quality: "medium", master: 0.8, effects: 0.9, music: 0.6, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,textScale:1,highContrast:false,pauseOnBlur:true,subtitles:true,cameraShake:true,bindings:defaultBindings(),performanceDisplay:false,graphics:{...GRAPHICS_PRESETS.medium} };
  seed = "ABYSS-7";
  difficulty: "easy" | "normal" | "hard" = "normal";
  doctrine: Doctrine = "balanced";
  private prep:{emphasis:"balanced"|"endurance"|"mission";reserve:number;authorize:boolean}={emphasis:"balanced",reserve:20,authorize:true};
  private focusTrap:FocusTrap|null=null;

  constructor(root: HTMLElement, cb: MenuCallbacks) {
    this.root = root;
    this.cb = cb;
    try{const raw=localStorage.getItem("abyss-settings");if(raw){const saved=JSON.parse(raw);Object.assign(this.settings,saved);this.settings.graphics=validateGraphics(saved.graphics??{renderScale:saved.renderScale,particles:saved.particleScale,fish:saved.fishScale});}}catch{}
  }
  private persist(){try{localStorage.setItem("abyss-settings",JSON.stringify(this.settings));}catch{}}

  private clear() {
    this.focusTrap?.deactivate();this.focusTrap=null;
    this.root.innerHTML = "";
  }

  private box(cls = "",onEscape?:()=>void): HTMLElement {
    const screen = document.createElement("div");
    screen.className = "menu-screen";
    const box = document.createElement("div");
    box.className = "menu-box " + cls;
    box.setAttribute("role","dialog");box.setAttribute("aria-modal","true");
    screen.appendChild(box);
    this.root.appendChild(screen);
    this.focusTrap=new FocusTrap(screen,onEscape);this.focusTrap.activate();
    return box;
  }

  // ------------------------------------------------------------------ start

  showStart() {
    this.clear();
    const box = this.box();
    box.innerHTML = `
      <h1>ABYSS <b>COMMAND</b></h1>
      <div class="subtitle">Five submarines. One commander. Zero margin.</div>
      <p>You are the mission director overseeing <b>NEREUS</b>, the fleet's centralized
      command intelligence. NEREUS navigates, scouts, fights, and repairs — you choose
      the doctrine, set priorities, and make the calls that matter.</p>
      <p class="dim">A research facility in the Silent Trench has gone dark. Recover its data
      core and bring the fleet home before the storm closes the recovery window.</p>
      <h2>Mission seed</h2>
      <div class="seed-row">
        <input id="seed-input" maxlength="24" spellcheck="false" />
        <button id="seed-random">Random</button>
      </div>
      <h2>Difficulty</h2>
      <div class="card-row" id="diff-row"></div>
      <div class="menu-actions">
        <button class="primary" id="new-campaign">New Campaign</button><button id="continue-campaign">Continue Campaign</button><button id="start-btn">Standalone briefing</button>
      </div>
      <div class="menu-actions"><button id="main-settings">Settings</button><button id="main-controls">Controls</button><button id="main-credits">Credits</button></div>
      <h2>Controls</h2>
      <p class="dim">Click to select submarines (or keys 1–5). Drag to orbit, wheel to zoom,
      C cycles cameras, Space pauses, F doubles speed, P pings with the selected unit,
      J jams with Echo. Fleet orders and doctrines sit on the bottom bar.</p>
    `;
    const input = box.querySelector<HTMLInputElement>("#seed-input")!;
    input.value = this.seed;
    input.addEventListener("input", () => (this.seed = input.value || "ABYSS-7"));
    box.querySelector("#seed-random")!.addEventListener("click", () => {
      const s = `TRENCH-${Math.floor(Math.random() * 900 + 100)}`;
      this.seed = s;
      input.value = s;
    });
    const row = box.querySelector("#diff-row")!;
    for (const d of DIFFICULTIES) {
      const card = document.createElement("button");card.type="button";
      card.className = "select-card" + (d.id === this.difficulty ? " selected" : "");
      card.innerHTML = `<div class="name">${d.label}</div>
        <div class="desc">${d.id === "easy" ? "Forgiving sensors and damage. Learn the trench." : d.id === "normal" ? "The intended experience." : "Sharp sensors, heavy damage, tight clock."}</div>`;
      card.addEventListener("click", () => {
        this.difficulty = d.id;
        row.querySelectorAll(".select-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
      });
      row.appendChild(card);
    }
    box.querySelector("#start-btn")!.addEventListener("click", () => {
      this.cb.onStart(this.seed, this.difficulty);
    });
    box.querySelector("#new-campaign")!.addEventListener("click",()=>this.cb.onNewCampaign());
    box.querySelector("#continue-campaign")!.addEventListener("click",()=>this.cb.onContinueCampaign("latest"));
    box.querySelector("#main-settings")!.addEventListener("click",()=>this.showSettings(()=>this.showStart()));
    box.querySelector("#main-controls")!.addEventListener("click",()=>this.showControls(()=>this.showStart()));
    box.querySelector("#main-credits")!.addEventListener("click",()=>this.showCredits(()=>this.showStart()));
  }

  showCampaign(state:CampaignState){this.clear();const box=this.box("campaign-hub");box.innerHTML=`<h1>FLEET <b>OPERATIONS</b></h1><div class="subtitle">${escapeHtml(state.name)} · ${escapeHtml(state.seed)}</div><p class="dim">Service time ${state.serviceTime} · Fleet readiness ${state.fleet.filter(v=>!v.lost&&v.readiness!=="unavailable").length}/5</p><div class="operation-map">${CAMPAIGN_OPERATIONS.map((op,i)=>{const a=operationAvailable(state,op.id),done=state.completedMissions.includes(op.id);return`<button data-operation="${op.id}" ${a.available?"":"disabled"}><span>${i+1}</span><b>${op.title}</b><small>${done?"Complete":a.available?`${op.threat} · ${op.intel}`:a.reason}</small></button>`}).join("")}</div><h2>Persistent fleet</h2><div class="debrief-stats">${state.fleet.map(v=>`<div><div class="k">${v.role}</div><div class="v">${v.lost?"LOST":`${Math.round(v.hull)}% · ${v.readiness}`} · ${v.upgrades.join(", ")||"standard"}</div></div>`).join("")}</div><div class="menu-actions"><button id="service">Prioritize servicing</button><button id="campaign-menu">Main menu</button></div>`;box.querySelectorAll<HTMLButtonElement>("[data-operation]").forEach(b=>b.addEventListener("click",()=>this.cb.onCampaignOperation(b.dataset.operation!)));box.querySelector("#service")?.addEventListener("click",()=>this.cb.onServiceCampaign());box.querySelector("#campaign-menu")?.addEventListener("click",()=>this.showStart());}

  // --------------------------------------------------------------- briefing

  showBriefing() {
    this.clear();
    const box = this.box();
    box.innerHTML = `
      <h1>THE SILENT <b>TRENCH</b></h1>
      <div class="subtitle">Mission briefing · Seed ${escapeHtml(this.seed)}</div>
      <p>Research station <b>KETO-DEEP</b> stopped transmitting 41 hours ago. Its data core
      contains a year of abyssal survey work. An automated security grid still guards the
      site, and a minefield belts the southern approach. A surface storm will close the
      recovery window — when time expires, extraction becomes impossible.</p>
      <p class="dim">Plan: survey both canyon routes · locate the facility · Mender recovers the core ·
      escort the carrier to extraction. Success requires the core <i>and at least three
      submarines</i> inside the extraction zone.</p>
      <h2>Fleet</h2>
      <p class="dim"><b>ATLAS</b> command &amp; sensors · <b>GHOST</b> stealth recon ·
      <b>LANCER</b> tactical defense · <b>ECHO</b> survey &amp; jamming ·
      <b>MENDER</b> repair &amp; recovery. NEREUS assigns all tasks; you steer intent.</p>
      <h2>Choose doctrine</h2>
      <div class="card-row" id="doc-row"></div>
      <h2>Fleet preparation</h2>
      <div class="settings-grid"><label>Loadout emphasis</label><div class="seg"><button data-loadout="balanced" class="active">Balanced</button><button data-loadout="endurance">Endurance</button><button data-loadout="mission">Mission</button></div><label>Emergency reserve</label><input id="prep-reserve" type="range" min="5" max="40" value="20"/><label>Scarce resources</label><label class="check"><input id="prep-authorize" type="checkbox" checked/> NEREUS may use authorized scarce supplies</label></div>
      <div class="menu-actions">
        <button class="primary" id="deploy-btn">Deploy the fleet</button>
      </div>
    `;
    const row = box.querySelector("#doc-row")!;
    (["silent", "balanced", "urgent"] as Doctrine[]).forEach((d) => {
      const card = document.createElement("button");card.type="button";
      card.className = "select-card" + (d === this.doctrine ? " selected" : "");
      card.innerHTML = `<div class="name">${DOCTRINE[d].label}</div><div class="desc">${DOCTRINE[d].desc}</div>`;
      card.addEventListener("click", () => {
        this.doctrine = d;
        row.querySelectorAll(".select-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
      });
      row.appendChild(card);
    });
    box.querySelector("#deploy-btn")!.addEventListener("click", () => this.cb.onDeploy(this.doctrine,this.prep));
    box.querySelectorAll<HTMLButtonElement>("[data-loadout]").forEach(button=>button.addEventListener("click",()=>{box.querySelectorAll("[data-loadout]").forEach(x=>x.classList.remove("active"));button.classList.add("active");this.prep.emphasis=button.dataset.loadout as typeof this.prep.emphasis;}));const reserve=box.querySelector<HTMLInputElement>("#prep-reserve")!,authorize=box.querySelector<HTMLInputElement>("#prep-authorize")!;reserve.value=String(this.prep.reserve);authorize.checked=this.prep.authorize;reserve.addEventListener("input",()=>this.prep.reserve=Number(reserve.value));authorize.addEventListener("change",()=>this.prep.authorize=authorize.checked);
  }

  // ------------------------------------------------------------------ pause

  showPause() {
    this.clear();
    const box = this.box("",()=>this.cb.onResume());
    box.innerHTML = `
      <h1>PAUSED</h1>
      <div class="subtitle">Simulation suspended — cameras remain live</div>
      <div class="menu-actions" style="flex-direction:column;align-items:stretch">
        <button class="primary" id="resume-btn">Resume</button>
        <button id="settings-btn">Settings</button>
        <button id="restart-btn">Restart (same seed)</button>
        <button id="restart-new-btn">Restart (new seed)</button>
        <button id="quit-btn" class="danger">Abort to menu</button>
      </div>
    `;
    box.querySelector("#resume-btn")!.addEventListener("click", () => this.cb.onResume());
    box.querySelector("#settings-btn")!.addEventListener("click", () => this.showSettings(() => this.showPause()));
    box.querySelector("#restart-btn")!.addEventListener("click", () => this.cb.onRestart(true));
    box.querySelector("#restart-new-btn")!.addEventListener("click", () => this.cb.onRestart(false));
    box.querySelector("#quit-btn")!.addEventListener("click", () => this.cb.onQuitToMenu());
  }

  showStorageRecovery(error:{title:string;message:string;raw?:string;canRetry?:boolean;canDelete?:boolean}){this.clear();const box=this.box("storage-recovery");box.innerHTML=`<h1>SAVE RECOVERY</h1><div class="subtitle">${escapeHtml(error.title)}</div><p>${escapeHtml(error.message)}</p><p class="dim">Your active result remains in memory. Export the raw save before deleting, or retry when storage is available.</p><div class="menu-actions">${error.canRetry?'<button class="primary" id="retry">Retry save</button>':''}${error.raw?'<button id="export">Export raw save</button>':''}${error.canDelete?'<button id="delete" class="danger">Delete damaged save</button>':''}<button id="return">Return safely</button></div>`;box.querySelector("#retry")?.addEventListener("click",()=>this.cb.onStorageRetry());box.querySelector("#export")?.addEventListener("click",()=>this.cb.onStorageExport());box.querySelector("#delete")?.addEventListener("click",()=>this.cb.onStorageDelete());box.querySelector("#return")?.addEventListener("click",()=>this.showStart());}

  // --------------------------------------------------------------- settings

  showSettings(back: () => void) {
    this.clear();
    const box = this.box("",back);
    box.innerHTML = `
      <h1>SETTINGS</h1>
      <div class="subtitle">Rendering &amp; audio</div>
      <div class="settings-grid">
        <label>Quality</label>
        <div class="seg" id="quality-seg"></div>
        <label>Master volume</label>
        <input type="range" id="vol-master" min="0" max="1" step="0.05" />
        <label>Effects</label>
        <input type="range" id="vol-effects" min="0" max="1" step="0.05" />
        <label>Music</label>
        <input type="range" id="vol-music" min="0" max="1" step="0.05" />
        <label>Motion</label>
        <label class="check"><input type="checkbox" id="reduced-motion" /> Reduced camera motion</label>
        <label>Text size</label><input type="range" id="text-scale" min="0.9" max="1.35" step="0.05" />
        <label>Contrast</label><label class="check"><input type="checkbox" id="high-contrast" /> High contrast interface</label>
        <label>Focus</label><label class="check"><input type="checkbox" id="pause-blur" /> Pause when focus is lost</label>
        <label>Subtitles</label><label class="check"><input type="checkbox" id="subtitles" /> Interface and event subtitles</label>
        <label>Camera shake</label><label class="check"><input type="checkbox" id="camera-shake" /> Impact camera shake</label><label>Performance</label><label class="check"><input type="checkbox" id="performance-display" /> Show measured frame rate</label>
        <fieldset class="custom-graphics"><legend>Custom graphics</legend><label>Render scale <output data-gfx-out="renderScale"></output><input data-gfx="renderScale" type="range" min="0.75" max="2" step="0.25"/></label><label>Anti-aliasing<select data-gfx="antiAliasing"><option value="off">Off</option><option value="fxaa">FXAA</option><option value="msaa+fxaa">MSAA + FXAA</option></select></label><label class="check"><input data-gfx="shadows" type="checkbox"/> Shadows</label><label>Particles <output data-gfx-out="particles"></output><input data-gfx="particles" type="range" min="0" max="1" step="0.1"/></label><label>Fish <output data-gfx-out="fish"></output><input data-gfx="fish" type="range" min="0" max="1" step="0.1"/></label><label>Terrain detail<select data-gfx="terrainDetail"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label>Model detail<select data-gfx="modelDetail"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label class="check"><input data-gfx="postprocessing" type="checkbox"/> Postprocessing</label><label class="check"><input data-gfx="sonarEffects" type="checkbox"/> Sonar effects</label><label class="check"><input data-gfx="sedimentEffects" type="checkbox"/> Sediment effects</label><label>Label distance <output data-gfx-out="labelDistance"></output><input data-gfx="labelDistance" type="range" min="300" max="3000" step="100"/></label><button type="button" id="reset-custom">Reset to Medium</button></fieldset><label>Key bindings</label><div class="bindings">${ACTIONS.map(a=>`<label>${a.label}<input data-bind="${a.id}" /></label>`).join("")}</div>
      </div>
      <div class="menu-actions"><button class="primary" id="back-btn">Back</button></div>
    `;
    const seg = box.querySelector("#quality-seg")!;
    (["low", "medium", "high", "custom"] as Quality[]).forEach((q) => {
      const b = document.createElement("button");
      b.textContent = q;
      b.classList.toggle("active", this.settings.quality === q);
      b.addEventListener("click", () => {
        this.settings.quality = q;if(q!=="custom")this.settings.graphics={...GRAPHICS_PRESETS[q]};
        seg.querySelectorAll("button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this.cb.onQuality(q);this.persist();
      });
      seg.appendChild(b);
    });
    const wire = (id: string, kind: "master" | "effects" | "music") => {
      const input = box.querySelector<HTMLInputElement>(id)!;
      input.value = String(this.settings[kind]);
      input.addEventListener("input", () => {
        this.settings[kind] = Number(input.value);
        this.cb.onVolume(kind, this.settings[kind]);this.persist();
      });
    };
    wire("#vol-master", "master");
    wire("#vol-effects", "effects");
    wire("#vol-music", "music");
    const rm = box.querySelector<HTMLInputElement>("#reduced-motion")!;
    rm.checked = this.settings.reducedMotion;
    rm.addEventListener("change", () => {
      this.settings.reducedMotion = rm.checked;
      this.cb.onReducedMotion(rm.checked);this.persist();
    });
    const scale=box.querySelector<HTMLInputElement>("#text-scale")!;scale.value=String(this.settings.textScale);scale.addEventListener("input",()=>{this.settings.textScale=Number(scale.value);document.documentElement.style.fontSize=`${15*this.settings.textScale}px`;this.persist();});const contrast=box.querySelector<HTMLInputElement>("#high-contrast")!;contrast.checked=this.settings.highContrast;contrast.addEventListener("change",()=>{this.settings.highContrast=contrast.checked;document.documentElement.classList.toggle("high-contrast",contrast.checked);this.persist();});const blur=box.querySelector<HTMLInputElement>("#pause-blur")!;blur.checked=this.settings.pauseOnBlur;blur.addEventListener("change",()=>{this.settings.pauseOnBlur=blur.checked;this.persist();});const subtitles=box.querySelector<HTMLInputElement>("#subtitles")!;subtitles.checked=this.settings.subtitles;subtitles.addEventListener("change",()=>{this.settings.subtitles=subtitles.checked;this.persist();});const shake=box.querySelector<HTMLInputElement>("#camera-shake")!;shake.checked=this.settings.cameraShake;shake.addEventListener("change",()=>{this.settings.cameraShake=shake.checked;this.persist();});
    const perf=box.querySelector<HTMLInputElement>("#performance-display")!;perf.checked=this.settings.performanceDisplay;perf.addEventListener("change",()=>{this.settings.performanceDisplay=perf.checked;this.persist();});const renderGraphics=()=>{for(const element of box.querySelectorAll<HTMLInputElement|HTMLSelectElement>("[data-gfx]")){const key=element.dataset.gfx as keyof GraphicsSettings;const value=this.settings.graphics[key];if(element instanceof HTMLInputElement&&element.type==="checkbox")element.checked=Boolean(value);else element.value=String(value);}for(const out of box.querySelectorAll<HTMLOutputElement>("[data-gfx-out]")){const key=out.dataset.gfxOut as keyof GraphicsSettings,value=this.settings.graphics[key];out.value=typeof value==="number"?(key==="particles"||key==="fish"?`${Math.round(value*100)}%`:key==="renderScale"?`${value.toFixed(2)}×`:`${value} m`):String(value);}};const applyGraphics=()=>{this.settings.quality="custom";this.settings.graphics=validateGraphics(this.settings.graphics);this.cb.onCustomGraphics(this.settings.graphics);renderGraphics();this.persist();};box.querySelectorAll<HTMLInputElement|HTMLSelectElement>("[data-gfx]").forEach(element=>element.addEventListener("input",()=>{const key=element.dataset.gfx as keyof GraphicsSettings;if(element instanceof HTMLInputElement&&element.type==="checkbox")(this.settings.graphics[key] as boolean)=element.checked;else if(element instanceof HTMLInputElement&&element.type==="range")(this.settings.graphics[key] as number)=Number(element.value);else (this.settings.graphics[key] as string)=element.value;applyGraphics();}));box.querySelector("#reset-custom")?.addEventListener("click",()=>{this.settings.graphics={...GRAPHICS_PRESETS.medium};applyGraphics();});renderGraphics();box.querySelectorAll<HTMLInputElement>("[data-bind]").forEach(input=>{const action=input.dataset.bind as keyof Bindings;input.value=this.settings.bindings[action];input.addEventListener("change",()=>{if(input.value.trim())this.settings.bindings[action]=input.value.trim();this.persist();});});
    box.querySelector("#back-btn")!.addEventListener("click", back);
  }

  showControls(back:()=>void){this.clear();const box=this.box("",back);box.innerHTML=`<h1>CONTROLS</h1><div class="subtitle">Keyboard reference</div><div class="settings-grid">${ACTIONS.map(a=>`<label>${a.label}</label><span>${this.settings.bindings[a.id]}</span>`).join("")}<label>Manual helm axes</label><span>W/S throttle · A/D steer · Q/E depth</span></div><div class="menu-actions"><button id="back" class="primary">Back</button></div>`;box.querySelector("#back")!.addEventListener("click",back);}
  showCredits(back:()=>void){this.clear();const box=this.box("",back);box.innerHTML=`<h1>CREDITS</h1><div class="subtitle">ABYSS COMMAND</div><p>Design, simulation, procedural geometry, audio, and interface generated for this project.</p><h2>Open-source software</h2><p class="dim"><b>Three.js 0.180.0</b> — MIT License — © 2010–2025 three.js authors.<br><b>modern-screenshot 4.7.0</b> — MIT License — © 2021-present wxm.<br><b>Vite, TypeScript, and Vitest</b> are development tooling under their respective open-source licenses.</p><p class="dim">All in-game geometry, textures, labels, and sound are generated procedurally; no external art or audio assets are bundled.</p><div class="menu-actions"><button id="back" class="primary">Back</button></div>`;box.querySelector("#back")!.addEventListener("click",back);}

  // --------------------------------------------------------------- debrief

  showDebrief(sim: Simulation, nereus: Nereus) {
    this.clear();
    const box = this.box();
    const won = sim.outcome === "won";
    const alive = sim.aliveUnits().length;
    const survivors = sim.units
      .map((u) => `${u.callsign} — ${u.state}${u.hasCore ? " (core)" : ""}`)
      .join("<br>");
    const mins = Math.floor(sim.now / 60);
    const secs = Math.floor(sim.now % 60);
    const keyDecisions = nereus.decisions
      .slice(-14)
      .map((d) => `<b>${Math.floor(d.time / 60)}:${Math.floor(d.time % 60).toString().padStart(2, "0")}</b> ${escapeHtml(d.text)}`)
      .join("<br>");
    const objectives = sim.objectives
      .map((o) => `${o.done || (o.kind === "extraction" && won) ? "✓" : "✗"} ${o.label}`)
      .join("<br>");
    const crownExtras=sim.crown?`<h2>Abyssal Crown phases</h2><p class="dim">${["insertion","canyon","network","minefield","defense","core","extraction"].map(p=>`${sim.crown!.completed.has(p as never)?"✓":"✗"} ${p}`).join("<br>")}</p><h2>Optional objectives</h2><p class="dim">${Object.entries(sim.crown.optional).map(([k,v])=>`${v?"✓":"✗"} ${k}`).join("<br>")}</p>`:"";
    box.innerHTML = `
      <h1 class="${won ? "outcome-won" : "outcome-lost"}">${won ? "MISSION COMPLETE" : "MISSION FAILED"}</h1>
      <div class="subtitle">${won ? "Data core delivered — the fleet is clear of the trench" : escapeHtml(sim.loseReason)}</div>
      <div class="debrief-stats">
        <div><div class="k">Outcome</div><div class="v">${won ? "Victory" : "Defeat"}</div></div>
        <div><div class="k">Mission time</div><div class="v">${mins}:${secs.toString().padStart(2, "0")}</div></div>
        <div><div class="k">Fleet survival</div><div class="v">${alive} / 5 submarines</div></div>
        <div><div class="k">Core status</div><div class="v">${sim.coreState === "carried" ? "Delivered aboard " + (sim.carrier()?.callsign ?? "—") : sim.coreState === "dropped" ? "Lost in the trench" : "Never recovered"}</div></div>
      </div>
      <h2>Objectives</h2>
      <p class="dim">${objectives}</p>
      <h2>Fleet</h2>
      <p class="dim">${survivors}</p>
      <h2>Logistics and servicing</h2>
      <div class="debrief-stats">${sim.units.map(u=>`<div><div class="k">${u.callsign}</div><div class="v">Energy ${Math.round(u.logistics.energy)}/${u.logistics.energyCapacity} · kits ${u.logistics.repairKits} · interceptors ${u.logistics.interceptors} · relays ${u.logistics.relays}</div></div>`).join("")}</div>
      <p class="dim">Subsystem damage persists in campaign sorties. Prioritize propulsion, communications, sensors, weapons, and repair equipment before the next operation.</p>
      <h2>NEREUS — key decisions</h2>
      <div class="debrief-decisions">${keyDecisions || "No significant replans recorded."}</div>
      ${crownExtras}
      <div class="menu-actions">
        <button class="primary" id="again-btn">Restart (same seed) — R</button>
        <button id="new-seed-btn">New seed — N</button>
        <button id="menu-btn">Main menu</button>
      </div>
    `;
    box.querySelector("#again-btn")!.addEventListener("click", () => this.cb.onRestart(true));
    box.querySelector("#new-seed-btn")!.addEventListener("click", () => this.cb.onRestart(false));
    box.querySelector("#menu-btn")!.addEventListener("click", () => this.cb.onQuitToMenu());
  }

  hideAll() {
    this.clear();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
