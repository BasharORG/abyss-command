# ABYSS COMMAND

A cinematic 3D underwater strategy game for the browser. You are the mission
director; **NEREUS**, a centralized fleet-command AI, autonomously controls a
fleet of exactly five submarines — navigation, formation, task allocation,
exploration, threat response, and coordinated action. You choose the doctrine,
issue fleet-level orders, and make the calls that matter.

**Flagship mission — The Silent Trench:** a research station has gone dark in a
deep canyon system. Survey the approaches, recover its data core with Mender,
and escort the carrier to extraction before a surface storm closes the window.
Success requires the core **and at least three submarines** inside the
extraction zone. A run takes roughly 8–12 minutes.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build / checks:

```bash
npm run build      # typecheck + bundle into dist/
npm test           # headless commander + mission-rule checks (vitest)
```

Release verification:

```bash
npm run build
npm test
npm run report:memory  # 3-minute Chrome run; writes reports/memory-long-run.json
npm run inspect:campaign  # real-UI pass through all 6 campaign operations
```

Serve `dist/` from any static HTTPS host. Campaign saves use browser `localStorage` and are scoped to the origin.

No account, backend, API key, or downloaded asset is required. WebGL 2 is
required; the game shows a clear fallback message when it is unavailable.

## Controls

| Input | Action |
| --- | --- |
| Click / `1–5` | Select a submarine (selecting focuses the camera; steering stays with NEREUS) |
| Drag / wheel | Orbit & zoom (Follow/Cinematic), pan & zoom (Tactical) |
| `C` | Cycle camera: Cinematic → Follow → Tactical |
| `Space` | Pause / resume (simulation halts; camera and orders stay live) |
| `F` | Toggle 2× speed |
| `P` | Active sonar ping with the selected unit (reveals contacts, broadcasts your position) |
| `J` | Echo sensor jam (when Echo is selected and off cooldown) |
| `M` / `H` / `Esc` | Mute / controls overlay / pause menu |

Manual Intervention adds `W/S` throttle, `A/D` steering, `Q/E` depth, `R` sonar, `F` role action, `X` countermeasure, and `Tab` vessel switching. Controls are also listed in the in-game Controls menu.

Touch devices receive contextual controls: vessel selection, camera cycling, pause, and a full Manual Intervention helm with held steering/throttle/depth controls plus sonar, role action, countermeasure, and return-to-NEREUS actions. Standard-mapping gamepads use the left stick for steering/throttle, triggers for depth, bumpers for vessel selection, face buttons for sonar/manual/countermeasure/camera, stick press for role action, and Start/Back for pause/help. D-pad and A/B navigate menus.

## Feature overview

- Centralized NEREUS fleet command with visible tasks and telemetry
- Manual Intervention for one submarine while NEREUS commands the remaining four
- Canyon, minefield, communications-blackout, defensive, recovery, and integrated operations
- Natural-language command console with deterministic local interpretation
- Persistent six-operation campaign, logistics, subsystem damage, service priorities, upgrades, and save slots
- Low, Medium, and High rendering presets; reduced-motion and high-contrast options

## Known limitations

- Campaign storage depends on available browser localStorage capacity.
- WebGL context restoration reloads the page; active standalone sorties are not checkpointed.
- Performance depends heavily on GPU fill rate and device pixel ratio.

## Performance conditions

The historical medium-setting reference was approximately 58 FPS and 127 draw calls in the development environment. This is not a universal guarantee. Low quality caps DPR at 1 and disables bloom/shadows; Medium caps DPR at 1.5; High caps DPR at 2 and enables shadows. Use the browser performance tools for device-specific measurement.

The long-run memory check serves the production bundle in headless Chrome, advances 30 simulated seconds before each 15-second sample, forces garbage collection, and measures post-GC JS heap trend, DOM nodes, listeners, Three.js resources, and bounded gameplay histories. Its default acceptance limits are 1 MiB/minute post-warmup heap growth, 12 MiB total post-warmup growth, 25 DOM nodes, and two renderer resources. Override run length with `MEMORY_DURATION_SECONDS`; shorter runs are useful for harness debugging but are not release evidence.

**Doctrines** (bottom-left): Silent, Balanced, Urgent — they change transit
speeds, risk aversion in route planning, and battery reserves.
**Fleet orders** (bottom-right): Advance, Regroup, Hold, Repairs, Investigate,
Extract. Advance/Investigate arm a target marker — click a point in the world
or on the tactical view. Orders that cannot be carried out are refused with a
reason. **Resume** hands the mission back to NEREUS.

## How NEREUS works (game AI — no LLM)

NEREUS is a centralized utility-based planner running locally at a 1 Hz
strategic cadence, with immediate event-driven replans (new contact, damage,
loss, dropped core, order change). Each plan tick it:

- builds candidate tasks from the mission phase, known contacts, and your orders;
- scores every (unit, task) pair on role aptitude, travel time, known-threat
  exposure, battery, damage, doctrine, and time pressure;
- greedily assigns with per-task reservations so units never compete for one
  objective (escorts allow two assignees);
- applies commitment timers and score hysteresis so units don't dither;
- slows units to quiet running near known threats, reroutes stuck units, pairs
  Mender with crippled allies, withdraws units low on battery, and substitutes
  recovery roles when Mender is lost (at a large time cost).

NEREUS only knows what the fleet has sensed: contacts carry uncertainty that
grows while unobserved, and terrain blocks line of sight for both sides. The
NEREUS panel and every "Replan" entry are generated from the actual selected
assignments — never decorative text.

## Architecture

```
src/
  config.ts          all gameplay/world/presentation tuning in one place
  types.ts           typed unit / contact / order / objective / event models
  rng.ts             seeded RNG (mulberry32) — missions are deterministic per seed
  world/terrain.ts   seeded heightfield: plateau, carved canyons, basins, LOS queries
  world/mission.ts   mission layout + route-existence validation
  sim/navigation.ts  A* over a clearance grid with a known-threat danger field
  sim/units.ts       bounded 3D movement physics, separation steering
  sim/simulation.ts  fixed-step (60 Hz) sim: sensing, nodes, mines, torpedoes,
                     repair, battery, mission phases, win/loss
  ai/nereus.ts       the centralized commander (utility planner)
  render/            three.js: procedural submarines, terrain, ocean atmosphere,
                     pooled effects, cameras, postprocessing
  audio/audio.ts     procedural WebAudio: ambience, pings, warnings, impacts, pad
  ui/                DOM HUD (roster, orders, minimap, NEREUS panel) + menus
  game.ts            state machine, input, fixed-step loop with interpolation
tests/               vitest: allocation, identity, mission rules, headless full run
```

Rendering is interpolated between fixed simulation steps, so decisions are
frame-rate independent. Effects are pooled (zero per-frame allocation), rocks
are instanced, particles are capped, and quality presets (low/medium/high)
scale pixel ratio, bloom, shadows, headlights, and particle density.

## Assets & licenses

All in-game geometry, textures, and audio are generated procedurally in code at runtime. Runtime dependencies still carry license obligations. Built on [three.js](https://threejs.org) (MIT) and `modern-screenshot` (MIT). See `THIRD_PARTY_NOTICES.md` for retained notices.

## License

ABYSS COMMAND's own source code and procedural assets are distributed under the MIT License (see `LICENSE`). Third-party dependencies remain under their own licenses (see `THIRD_PARTY_NOTICES.md`).

## Honest limitations

- Desktop-first: pointer/keyboard is the reference input; touch selection and
  single-finger camera work, pinch zoom does not.
- Ambient occlusion is approximated by depth-graded lighting and fog rather
  than a true SSAO pass.
- Sound is a fully procedural soundscape; there is no recorded voice or music.
- The 60 FPS target was verified in this dev environment at medium settings
  (~58 fps, ~127 draw calls); very low-end GPUs may need the Low preset.
- An LLM "admiral's voice" adapter for NEREUS is a deliberate future extension;
  the shipped commander is classic game AI and the UI never implies otherwise.
