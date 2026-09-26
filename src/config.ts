/** All gameplay, world, and presentation tuning lives here. */

export const WORLD = {
  /** world extents, meters. World is centered on origin: x,z in [-HALF, HALF] */
  HALF: 1400,
  /** water surface at y = 0; depths are negative y */
  SURFACE_Y: 0,
  /** minimum allowed depth (max dive) */
  MAX_DEPTH: 320,
  /** keep subs this far below the surface */
  SURFACE_MARGIN: 18,
  /** keep subs this far above the seabed */
  SEABED_MARGIN: 10,
  /** typical cruise depth band */
  CRUISE_DEPTH: 120,
  /** grid cell size for navigation (m) */
  NAV_CELL: 40
} as const;

export const SIM = {
  DT: 1 / 60,
  /** commander strategic cadence, sim seconds */
  PLAN_INTERVAL: 1.0,
  /** hysteresis: new task must beat current by this relative margin */
  HYSTERESIS: 1.12,
  /** minimum commitment to a task before voluntary replan (s) */
  COMMIT_TIME: 6,
  STUCK_INTERVAL: 2.0,
  STUCK_DIST: 6
} as const;

export interface RoleSpec {
  maxSpeed: number; // flank m/s
  cruiseSpeed: number; // standard
  silentSpeed: number;
  accel: number;
  turnRate: number; // rad/s
  vertRate: number; // m/s depth change
  hull: number;
  passiveRange: number; // detection of threats, m
  activeRange: number; // active ping range, m
  signature: number; // base noise emitted
  torpedoes: number;
  repairKits: number;
  size: number; // render scale
  length: number; // rendered hull length, m
  radius: number; // rendered hull radius, m
}

export const ROLE_SPECS: Record<string, RoleSpec> = {
  ATLAS: {
    maxSpeed: 13, cruiseSpeed: 8, silentSpeed: 4, accel: 3.5, turnRate: 0.5, vertRate: 5,
    hull: 160, passiveRange: 300, activeRange: 520, signature: 34, torpedoes: 0, repairKits: 0, size: 1.35,
    length: 67.5, radius: 6.48
  },
  GHOST: {
    maxSpeed: 18, cruiseSpeed: 12, silentSpeed: 6, accel: 6, turnRate: 0.9, vertRate: 8,
    hull: 70, passiveRange: 320, activeRange: 560, signature: 12, torpedoes: 0, repairKits: 0, size: 0.8,
    length: 34.4, radius: 3
  },
  LANCER: {
    maxSpeed: 15, cruiseSpeed: 10, silentSpeed: 5, accel: 4.5, turnRate: 0.7, vertRate: 6,
    hull: 110, passiveRange: 260, activeRange: 480, signature: 22, torpedoes: 6, repairKits: 0, size: 1.0,
    length: 47, radius: 4.15
  },
  ECHO: {
    maxSpeed: 14, cruiseSpeed: 9, silentSpeed: 5, accel: 4.2, turnRate: 0.65, vertRate: 6,
    hull: 90, passiveRange: 460, activeRange: 700, signature: 24, torpedoes: 0, repairKits: 0, size: 1.05,
    length: 48.3, radius: 4.73
  },
  MENDER: {
    maxSpeed: 14, cruiseSpeed: 9, silentSpeed: 5, accel: 4, turnRate: 0.6, vertRate: 6,
    hull: 100, passiveRange: 240, activeRange: 440, signature: 26, torpedoes: 0, repairKits: 4, size: 1.1,
    length: 48.4, radius: 5.12
  }
};

export const DETECTION = {
  /** base range at which a security node detects a unit of noise N: radius * noiseFactor */
  NOISE_REFERENCE: 30,
  /** suspicion fill rate per second at zero distance margin, scaled by proximity */
  SUSPICION_RATE: 0.45,
  SUSPICION_DECAY: 0.25,
  ALERT_TIME: 8, // seconds a node stays alert after losing contact
  FIRE_COOLDOWN: 6,
  /** contact uncertainty growth per second since last seen (m/s) */
  UNCERTAINTY_GROWTH: 4,
  /** terrain LOS sample step (m) */
  LOS_STEP: 24,
  PING_NOISE_BOOST: 45,
  PING_DURATION: 4,
  PING_COOLDOWN: 12,
  JAM_DURATION: 10,
  JAM_COOLDOWN: 30,
  JAM_RADIUS: 260
} as const;

export const COMBAT = {
  TORPEDO_SPEED: 55,
  TORPEDO_TTL: 14,
  TORPEDO_DAMAGE: 45,
  TORPEDO_RANGE: 520,
  NODE_PROJECTILE_SPEED: 38,
  NODE_PROJECTILE_DAMAGE: 26,
  NODE_FIRE_RANGE_FACTOR: 0.9, // fires within this fraction of detect radius
  MINE_DAMAGE: 55,
  MINE_SPLASH: 30, // damage at damageRadius edge
  /** stand-off range for LANCER attack runs */
  ATTACK_STANDOFF: 380,
  /** repair: meters, per-second hull restored, kits consumed per use */
  REPAIR_RANGE: 40,
  REPAIR_RATE: 9, // hull per second
  REPAIR_AMOUNT: 45, // hull restored per kit
  RECOVER_TIME: 30, // seconds for MENDER to recover core at facility
  RECOVER_TIME_SLOW: 75, // for a substitute unit
  FETCH_TIME: 25, // retrieve a dropped core (substitute)
  FETCH_TIME_MENDER: 10,
  SURVEY_TIME: 12, // seconds on station to complete a route survey
  INTERACT_RANGE: 46,
  DISABLED_HULL: 25 // below this, unit is disabled (dead in water)
} as const;

export const DOCTRINE = {
  silent: {
    speedBias: 0, // speedOrder preference
    dangerAversion: 2.2,
    batteryReserve: 45,
    label: "Silent",
    desc: "Concealment first: slow transit, passive sensing, safe routes."
  },
  balanced: {
    speedBias: 1,
    dangerAversion: 1.3,
    batteryReserve: 30,
    label: "Balanced",
    desc: "Trade speed against safety; preserve critical resources."
  },
  urgent: {
    speedBias: 2,
    dangerAversion: 0.7,
    batteryReserve: 18,
    label: "Urgent",
    desc: "Accept exposure to finish faster."
  }
} as const;

export const SCORING = {
  SURVIVORS_REQUIRED: 3,
  STORM_WARN_AT: 120 // seconds remaining → warning
} as const;

export const COLORS = {
  fogShallow: 0x0b2e3d,
  fogDeep: 0x02070f,
  waterTop: 0x0d3a4a,
  hull: 0x3d4a52,
  hullDark: 0x2a343b,
  cyan: 0x7fd8e8,
  amber: 0xffb347,
  red: 0xff5340,
  idLight: {
    ATLAS: 0x9fb8c4,
    GHOST: 0x64e3d4,
    LANCER: 0xffb347,
    ECHO: 0x8ab8ff,
    MENDER: 0x9fe8a8
  }
} as const;
