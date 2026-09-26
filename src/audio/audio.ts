import { Role, SimEvent } from "../types";

/**
 * Procedural WebAudio soundscape: layered ambience, engine hum, sonar
 * pings, warnings, muffled impacts, and a slow adaptive pad.
 * Starts only after a user gesture.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private ambience!: GainNode;
  private tensionLevel = 0;
  private started = false;
  private padOscs: OscillatorNode[] = [];
  private padGain!: GainNode;
  private tensionOsc: OscillatorNode | null = null;
  private tensionGain!: GainNode;
  private humOsc: OscillatorNode | null = null;
  private humGain!: GainNode;
  private delayed = new Set<number>();

  volumes = { master: 0.8, effects: 0.9, music: 0.6 };
  muted = false;

  /** must be called from a user gesture */
  start() {
    if (this.started) return;
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.started = true;

    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.connect(this.master);
    this.ambience = ctx.createGain();
    this.ambience.connect(this.master);
    this.applyVolumes();

    // --- underwater ambience: filtered noise ---
    const noise = this.makeNoiseSource();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    lp.Q.value = 0.4;
    const ambGain = ctx.createGain();
    ambGain.gain.value = 0.16;
    noise.connect(lp).connect(ambGain).connect(this.ambience);
    noise.start();
    // slow swell via LFO on filter
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();

    // --- engine hum ---
    this.humOsc = ctx.createOscillator();
    this.humOsc.type = "sine";
    this.humOsc.frequency.value = 42;
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0.05;
    this.humOsc.connect(this.humGain).connect(this.ambience);
    this.humOsc.start();

    // --- music pad: slow detuned sines through a gentle lowpass ---
    this.padGain = ctx.createGain();
    this.padGain.gain.value = 0.05;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 700;
    this.padGain.connect(padFilter).connect(this.music);
    const chords = [55, 82.4, 110, 164.8];
    for (const f of chords) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = 0.25 / chords.length;
      o.connect(og).connect(this.padGain);
      o.start();
      this.padOscs.push(o);
    }

    // --- tension layer (silent until alerts) ---
    this.tensionOsc = ctx.createOscillator();
    this.tensionOsc.type = "triangle";
    this.tensionOsc.frequency.value = 220;
    this.tensionGain = ctx.createGain();
    this.tensionGain.gain.value = 0;
    this.tensionOsc.connect(this.tensionGain).connect(this.music);
    this.tensionOsc.start();
  }

  private makeNoiseSource(): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // brown-ish
      data[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  applyVolumes() {
    if (!this.started) return;
    const m = this.muted ? 0 : this.volumes.master;
    this.master.gain.value = m;
    this.sfx.gain.value = this.volumes.effects;
    this.music.gain.value = this.volumes.music;
    this.ambience.gain.value = 0.9;
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.applyVolumes();
  }

  /** map simulation events to cues */
  event(e: SimEvent) {
    if (!this.started || this.muted) return;
    switch (e.kind) {
      case "ping":
        this.ping();
        break;
      case "nodeAlert":
        this.warning(0.5);
        break;
      case "warning":
        this.warning(0.3);
        break;
      case "mineHit":
      case "torpedoHit":
        this.impact(0.8);
        break;
      case "contact":
        if (/rockfall|barrier|obstruction/i.test(e.text)) this.rockfall();
        break;
      case "phaseChange":
        if (/rockfall introduced/i.test(e.text)) this.rockfall();
        break;
      case "unitDamaged":
        this.impact(0.5);
        break;
      case "unitDestroyed":
        this.impact(1);
        this.warning(0.8);
        break;
      case "unitDisabled":
        this.warning(0.7);
        break;
      case "objectiveDone":
      case "coreRecovered":
        this.chime();
        break;
      case "jam":
        this.jamSweep();
        break;
      default:
        break;
    }
  }

  private blip(freq: number, dur: number, gain: number, type: OscillatorType = "sine") {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.sfx);
    o.start();
    o.stop(ctx.currentTime + dur + 0.05);
  }

  ping() {
    const ctx = this.ctx!;
    // classic sonar: sweep down with a delayed echo
    for (const [delay, g] of [
      [0, 0.22],
      [0.35, 0.1],
      [0.7, 0.05]
    ] as const) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(1400, ctx.currentTime + delay);
      o.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + delay + 0.6);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, ctx.currentTime + delay);
      gain.gain.linearRampToValueAtTime(g, ctx.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.7);
      o.connect(gain).connect(this.sfx);
      o.start(ctx.currentTime + delay);
      o.stop(ctx.currentTime + delay + 0.8);
    }
  }

  warning(intensity: number) {
    this.blip(620, 0.18, 0.14 * intensity, "square");
    const id=window.setTimeout(()=>{this.delayed.delete(id);if(this.started)this.blip(520,.22,.12*intensity,"square");},200);this.delayed.add(id);
  }

  impact(intensity: number) {
    const ctx = this.ctx!;
    const noise = this.makeNoiseSource();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(900, ctx.currentTime);
    lp.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * intensity, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.1);
    noise.connect(lp).connect(g).connect(this.sfx);
    noise.start();
    noise.stop(ctx.currentTime + 1.2);
    // low thump
    this.blip(60, 0.7, 0.3 * intensity, "sine");
  }

  rockfall() {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const noise = this.makeNoiseSource();
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(260, ctx.currentTime); lp.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 2.2);
    const g = ctx.createGain(); g.gain.setValueAtTime(.22, ctx.currentTime); g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + 2.4);
    noise.connect(lp).connect(g).connect(this.sfx); noise.start(); noise.stop(ctx.currentTime + 2.5);
    this.blip(38, 1.5, .24, "sine");
  }

  chime() {
    this.blip(880, 0.5, 0.1);
    const id=window.setTimeout(()=>{this.delayed.delete(id);if(this.started)this.blip(1320,.6,.08);},160);this.delayed.add(id);
  }

  jamSweep() {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(200, ctx.currentTime);
    o.frequency.linearRampToValueAtTime(90, ctx.currentTime + 1.4);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.6);
    o.connect(lp).connect(g).connect(this.sfx);
    o.start();
    o.stop(ctx.currentTime + 1.7);
  }

  /** continuous update: tension follows alert state */
  update(dt: number, tension: number, fleetSpeedRatio: number, selectedRole: Role = "ATLAS", depthRatio = 0) {
    if (!this.started) return;
    this.tensionLevel += (tension - this.tensionLevel) * Math.min(1, dt * 0.8);
    if (this.tensionGain) {
      this.tensionGain.gain.value = this.tensionLevel * 0.04;
      this.tensionOsc!.frequency.value = 220 + this.tensionLevel * 60;
    }
    if (this.padGain) {
      this.padGain.gain.value = 0.05 + this.tensionLevel * 0.02;
    }
    if (this.humGain) {
      const character: Record<Role, [number, number]> = {
        ATLAS: [34, .062], GHOST: [58, .028], LANCER: [46, .052], ECHO: [42, .042], MENDER: [38, .047]
      };
      const [base, gain] = character[selectedRole];
      this.humGain.gain.value = gain + fleetSpeedRatio * .045;
      this.humOsc!.frequency.value = base + fleetSpeedRatio * 20 + depthRatio * 3;
    }
  }
  suspend(){void this.ctx?.suspend();}
  resume(){if(this.ctx?.state==="suspended")void this.ctx.resume();}
  resetMissionMix(){this.tensionLevel=0;if(this.tensionGain)this.tensionGain.gain.value=0;for(const id of this.delayed)clearTimeout(id);this.delayed.clear();}
}
