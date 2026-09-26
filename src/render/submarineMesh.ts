import * as THREE from "three";
import { Role } from "../types";
import { COLORS, ROLE_SPECS } from "../config";

let sharedRoughnessTexture: THREE.CanvasTexture | null = null;
let sharedGlowTexture: THREE.CanvasTexture | null = null;

function glowTexture(): THREE.CanvasTexture {
  if (sharedGlowTexture) return sharedGlowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 31);
  gradient.addColorStop(0, "rgba(255,255,255,0.9)");
  gradient.addColorStop(0.35, "rgba(255,255,255,0.35)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  sharedGlowTexture = texture;
  return texture;
}

function roughnessTexture(): THREE.CanvasTexture {
  if (sharedRoughnessTexture) return sharedRoughnessTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(128, 128);
  let seed = 0x51f15e;
  for (let i = 0; i < image.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const grain = 158 + ((seed >>> 25) & 31);
    image.data[i] = grain;
    image.data[i + 1] = grain;
    image.data[i + 2] = grain;
    image.data[i + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 2);
  sharedRoughnessTexture = texture;
  return texture;
}

function hullMaterial(role: Role): THREE.MeshStandardMaterial {
  const color: Record<Role, number> = {
    ATLAS: 0x53616a,
    GHOST: 0x303c43,
    LANCER: 0x4c5961,
    ECHO: 0x53636d,
    MENDER: 0x59665f
  };
  return new THREE.MeshStandardMaterial({
    color: color[role],
    metalness: role === "GHOST" ? 0.42 : 0.68,
    roughness: role === "GHOST" ? 0.7 : 0.46,
    roughnessMap: roughnessTexture()
  });
}

function material(color: number, metalness = 0.62, roughness = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

function addMesh(group: THREE.Group, geometry: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

type HullShape = "carrier" | "stealth" | "hunter" | "sensor" | "utility";

function makeHull(length: number, radius: number, shape: HullShape, mat: THREE.Material): THREE.Mesh {
  const points: THREE.Vector2[] = [];
  const segments = 24;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const stern = THREE.MathUtils.smoothstep(t, 0, shape === "stealth" ? 0.32 : 0.22);
    const bowStart = shape === "carrier" ? 0.77 : shape === "hunter" ? 0.68 : 0.72;
    const bow = 1 - THREE.MathUtils.smoothstep(t, bowStart, 1);
    const cylindrical = shape === "carrier" ? 0.12 : shape === "utility" ? 0.08 : 0;
    const shoulder = 1 + cylindrical * Math.sin(Math.min(1, t / 0.65) * Math.PI);
    const sternFloor = shape === "stealth" ? 0.12 : 0.2;
    const profile = Math.max(0.025, (sternFloor + (1 - sternFloor) * stern) * bow * shoulder);
    points.push(new THREE.Vector2(radius * profile, (t - 0.5) * length));
  }
  const geometry = new THREE.LatheGeometry(points, 24);
  geometry.rotateX(Math.PI / 2);
  const hull = new THREE.Mesh(geometry, mat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  if (shape === "stealth") hull.scale.y = 0.86;
  if (shape === "utility") hull.scale.y = 1.08;
  return hull;
}

function roundedFairing(width: number, height: number, length: number, mat: THREE.Material): THREE.Mesh {
  const geometry = new THREE.CapsuleGeometry(1, 1.4, 4, 12);
  geometry.rotateX(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.scale.set(width * 0.5, height * 0.5, length / 3.4);
  mesh.castShadow = true;
  return mesh;
}

function box(width: number, height: number, depth: number, mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
  mesh.castShadow = true;
  return mesh;
}

function taperedPlane(span: number, chord: number, thickness: number, mat: THREE.Material): THREE.Group {
  const assembly = new THREE.Group();
  const vertices = new Float32Array([
    0, -thickness, chord * 0.45, span, -thickness, chord * 0.12,
    span, -thickness, -chord * 0.32, 0, -thickness, -chord * 0.5,
    0, thickness, chord * 0.45, span, thickness, chord * 0.12,
    span, thickness, -chord * 0.32, 0, thickness, -chord * 0.5
  ]);
  const indices = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  for (const side of [-1, 1]) {
    const plane = new THREE.Mesh(geometry, mat);
    plane.scale.x = side;
    plane.castShadow = true;
    assembly.add(plane);
  }
  return assembly;
}

function makeProp(blades: number, radius: number, mat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.32, radius * 0.7, 12), mat);
  hub.rotation.x = Math.PI / 2;
  group.add(hub);
  for (let i = 0; i < blades; i++) {
    const holder = new THREE.Group();
    const blade = box(radius * 0.18, radius * 0.82, radius * 0.08, mat);
    blade.position.y = radius * 0.48;
    blade.rotation.z = 0.42;
    blade.rotation.y = -0.3;
    holder.rotation.z = (i / blades) * Math.PI * 2;
    holder.add(blade);
    group.add(holder);
  }
  return group;
}

function addHullSeams(group: THREE.Group, length: number, radius: number, k: number, mat: THREE.Material, count: number): void {
  for (let i = 1; i <= count; i++) {
    const z = THREE.MathUtils.lerp(-length * 0.3, length * 0.33, i / (count + 1));
    const seam = addMesh(group, new THREE.TorusGeometry(radius * 1.005, 0.035 * k, 5, 28), mat);
    seam.position.z = z;
  }
}

function addHatch(group: THREE.Group, x: number, y: number, z: number, radius: number, k: number, mat: THREE.Material): void {
  const hatch = addMesh(group, new THREE.CylinderGeometry(radius, radius, 0.14 * k, 16), mat);
  hatch.position.set(x, y, z);
  const hinge = box(radius * 0.32, 0.18 * k, radius * 1.5, mat);
  hinge.position.set(x + radius * 0.72, y + 0.08 * k, z);
  group.add(hinge);
}

function addMast(group: THREE.Group, x: number, y: number, z: number, height: number, k: number, mat: THREE.Material): THREE.Group {
  const assembly = new THREE.Group();
  assembly.position.set(x, y, z);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.2 * k, 0.25 * k, height, 10), mat);
  mast.position.y = height * 0.5;
  assembly.add(mast);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.28 * k, 8, 6), mat);
  cap.scale.z = 1.5;
  cap.position.set(0, height, 0.18 * k);
  assembly.add(cap);
  group.add(assembly);
  return assembly;
}

export interface SubmarineModel {
  group: THREE.Group;
  propellers: THREE.Object3D[];
  rudders: THREE.Object3D[];
  divePlanes: THREE.Object3D[];
  sensors: THREE.Object3D[];
  repairArms: THREE.Object3D[];
  weaponDoors: THREE.Object3D[];
  idLight: THREE.Mesh;
  headlight: THREE.SpotLight;
  role: Role;
}

export function buildSubmarine(role: Role): SubmarineModel {
  const k = ROLE_SPECS[role].size;
  const group = new THREE.Group();
  const hullMat = hullMaterial(role);
  const dark = material(COLORS.hullDark, 0.65, role === "GHOST" ? 0.78 : 0.56);
  const edge = material(0x151d21, 0.58, 0.62);
  const equipment = material(0x202a2f, 0.72, 0.42);
  const propellers: THREE.Object3D[] = [];
  const rudders: THREE.Object3D[] = [];
  const divePlanePivots: THREE.Object3D[] = [];
  const sensors: THREE.Object3D[] = [];
  const repairArms: THREE.Object3D[] = [];
  const weaponDoors: THREE.Object3D[] = [];
  const shape: Record<Role, HullShape> = {
    ATLAS: "carrier", GHOST: "stealth", LANCER: "hunter", ECHO: "sensor", MENDER: "utility"
  };
  const length = ROLE_SPECS[role].length;
  const radius = ROLE_SPECS[role].radius;

  const hull = makeHull(length, radius, shape[role], hullMat);
  group.add(hull);
  addHullSeams(group, length, radius, k, edge, role === "GHOST" ? 2 : role === "ATLAS" ? 6 : 4);

  const sailHeight = (role === "GHOST" ? 2.5 : role === "ATLAS" ? 4.8 : 3.8) * k;
  const sailLength = (role === "ATLAS" ? 11 : role === "GHOST" ? 7.5 : 8.5) * k;
  const sail = roundedFairing((role === "ATLAS" ? 2.9 : 2.25) * k, sailHeight, sailLength, hullMat);
  sail.position.set(0, radius + sailHeight * 0.37, length * (role === "GHOST" ? 0.03 : 0.08));
  group.add(sail);
  const sailBase = roundedFairing(3.5 * k, 0.7 * k, sailLength * 1.14, dark);
  sailBase.position.set(0, radius * 0.92, sail.position.z);
  group.add(sailBase);

  const sailTop = radius + sailHeight * 0.78;
  const primaryMast = addMast(group, -0.38 * k, sailTop, sail.position.z + 0.5 * k, role === "ECHO" ? 4.3 * k : 3.1 * k, k, equipment);
  if (role === "ECHO") sensors.push(primaryMast);
  if (role === "ATLAS" || role === "ECHO") sensors.push(addMast(group, 0.48 * k, sailTop, sail.position.z - 1.25 * k, 2.5 * k, k, dark));

  const sternPlanes = taperedPlane(6.1 * k, 5.2 * k, 0.18 * k, hullMat);
  sternPlanes.position.z = -length * 0.41;
  group.add(sternPlanes);
  const rudderPivot = new THREE.Group();
  const verticalPlanes = taperedPlane(5.4 * k, 5 * k, 0.18 * k, hullMat);
  verticalPlanes.rotation.z = Math.PI / 2;
  if (role === "GHOST") verticalPlanes.rotation.y = 0.2;
  rudderPivot.position.z = -length * 0.41;
  rudderPivot.add(verticalPlanes);
  group.add(rudderPivot);
  rudders.push(rudderPivot);

  const divePivot = new THREE.Group();
  const divePlanes = taperedPlane((role === "ATLAS" ? 6.8 : 5.2) * k, 3.2 * k, 0.14 * k, hullMat);
  divePivot.position.set(0, role === "GHOST" ? radius * 0.25 : radius * 0.82, length * (role === "GHOST" ? 0.2 : 0.08));
  divePivot.add(divePlanes);
  group.add(divePivot);
  divePlanePivots.push(divePivot);

  const propulsionZ = -length * 0.5 - 0.75 * k;
  const propRadius = (role === "ATLAS" ? 3.35 : role === "GHOST" ? 2.25 : 2.8) * k;
  const prop = makeProp(role === "ATLAS" ? 7 : role === "GHOST" ? 6 : 5, propRadius, equipment);
  prop.position.z = propulsionZ;
  group.add(prop);
  propellers.push(prop);
  if (role === "GHOST") {
    const shroud = addMesh(group, new THREE.TorusGeometry(propRadius * 1.08, 0.5 * k, 8, 24), dark);
    shroud.position.z = propulsionZ;
    const stator = addMesh(group, new THREE.CylinderGeometry(propRadius * 0.22, propRadius * 0.65, 2.3 * k, 16), dark);
    stator.rotation.x = Math.PI / 2;
    stator.position.z = propulsionZ - 0.9 * k;
  }

  const accent = new THREE.MeshStandardMaterial({
    color: 0x20272b,
    metalness: 0.5,
    roughness: 0.5,
    emissive: new THREE.Color(COLORS.idLight[role]),
    emissiveIntensity: 0.22
  });

  if (role === "ATLAS") {
    const dorsalDeck = roundedFairing(7.8 * k, 1.25 * k, 18 * k, dark);
    dorsalDeck.position.set(0, radius * 0.88, -length * 0.08);
    group.add(dorsalDeck);
    for (const side of [-1, 1]) {
      const cargoFairing = roundedFairing(2.5 * k, 2.4 * k, 18 * k, hullMat);
      cargoFairing.position.set(side * radius * 0.82, -radius * 0.25, -length * 0.03);
      group.add(cargoFairing);
    }
    addHatch(group, 0, radius + 0.1 * k, length * 0.3, 1.25 * k, k, equipment);
    for (const z of [-0.2, -0.08, 0.04]) addHatch(group, 0, radius + 0.15 * k, length * z, 0.85 * k, k, dark);
  } else if (role === "LANCER") {
    for (const side of [-1, 1]) {
      const weaponSponson = roundedFairing(2.2 * k, 2.5 * k, 19 * k, dark);
      weaponSponson.position.set(side * radius * 0.92, -0.5 * k, length * 0.03);
      group.add(weaponSponson);
      for (const z of [0.28, 0.35, 0.42]) {
        const tubeDoor = addMesh(group, new THREE.CylinderGeometry(0.62 * k, 0.62 * k, 0.14 * k, 12), equipment);
        tubeDoor.rotation.x = Math.PI / 2;
        tubeDoor.position.set(side * radius * 0.54, -radius * 0.3, length * z);
        weaponDoors.push(tubeDoor);
      }
    }
    const spine = box(0.55 * k, 0.45 * k, 16 * k, edge);
    spine.position.set(0, radius * 0.98, -length * 0.08);
    group.add(spine);
    addHatch(group, 0, radius + 0.08 * k, length * 0.31, 0.95 * k, k, equipment);
  } else if (role === "ECHO") {
    const sonarDome = addMesh(group, new THREE.SphereGeometry(3.35 * k, 18, 12), accent);
    sonarDome.scale.set(0.94, 0.88, 0.68);
    sonarDome.position.set(0, -0.25 * k, length * 0.47);
    for (const side of [-1, 1]) {
      const arrayBed = roundedFairing(0.6 * k, 2.5 * k, 20 * k, dark);
      arrayBed.position.set(side * radius * 0.99, -0.2 * k, -length * 0.03);
      group.add(arrayBed);
      for (let i = 0; i < 7; i++) {
        const tile = box(0.16 * k, 1.25 * k, 1.85 * k, accent);
        tile.position.set(side * radius * 1.07, -0.2 * k, -length * 0.2 + i * 2.65 * k);
        group.add(tile);
      }
    }
    const receiver = roundedFairing(4.8 * k, 1.1 * k, 6.4 * k, equipment);
    receiver.position.set(0, sailTop + 3.6 * k, sail.position.z + 0.5 * k);
    group.add(receiver);
    sensors.push(receiver);
  } else if (role === "MENDER") {
    const workBay = roundedFairing(5.5 * k, 2.2 * k, 15 * k, dark);
    workBay.position.set(0, -radius * 0.9, length * 0.08);
    group.add(workBay);
    for (const side of [-1, 1]) {
      const armPivot = new THREE.Group();
      armPivot.position.set(side * radius * 0.72, -radius * 0.72, length * 0.24);
      const shoulder = new THREE.Mesh(new THREE.CylinderGeometry(0.7 * k, 0.85 * k, 1.4 * k, 10), equipment);
      shoulder.rotation.z = Math.PI / 2;
      armPivot.add(shoulder);
      const upperArm = box(0.58 * k, 0.58 * k, 5.6 * k, equipment);
      upperArm.position.set(side * 0.3 * k, -1.2 * k, 2.8 * k);
      upperArm.rotation.x = -0.24;
      armPivot.add(upperArm);
      const claw = taperedPlane(1.1 * k, 1.8 * k, 0.11 * k, equipment);
      claw.scale.set(0.7, 0.7, 0.7);
      claw.position.set(side * 0.3 * k, -2.15 * k, 5.3 * k);
      claw.rotation.y = side * 0.35;
      armPivot.add(claw);
      group.add(armPivot);
      repairArms.push(armPivot);
    }
    for (const side of [-1, 1]) {
      const rail = box(0.22 * k, 0.22 * k, 17 * k, hullMat);
      rail.position.set(side * 2.8 * k, -radius - 1.45 * k, length * 0.02);
      group.add(rail);
    }
    addHatch(group, 0, radius + 0.08 * k, length * 0.3, 1.05 * k, k, equipment);
  } else {
    const bowChin = roundedFairing(2.7 * k, 1.6 * k, 8 * k, dark);
    bowChin.position.set(0, -radius * 0.72, length * 0.33);
    group.add(bowChin);
    const flushArray = roundedFairing(0.34 * k, 1.35 * k, 16 * k, accent);
    for (const side of [-1, 1]) {
      const array = flushArray.clone();
      array.position.set(side * radius * 0.94, -0.1 * k, length * 0.02);
      group.add(array);
    }
    addHatch(group, 0, radius * 0.9, length * 0.28, 0.75 * k, k, edge);
  }

  const stripe = box(0.12 * k, 0.36 * k, length * 0.34, accent);
  stripe.position.set(radius * 0.98, radius * 0.4, -length * 0.01);
  group.add(stripe);

  const idMat = new THREE.MeshStandardMaterial({
    color: 0x111111,
    emissive: new THREE.Color(COLORS.idLight[role]),
    emissiveIntensity: 2.2
  });
  const idLight = addMesh(group, new THREE.SphereGeometry(0.42 * k, 8, 6), idMat);
  idLight.position.set(0, sailTop + 0.45 * k, sail.position.z + sailLength * 0.24);
  const glowMat = new THREE.SpriteMaterial({
    map: glowTexture(),
    color: COLORS.idLight[role],
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(4.3 * k);
  glow.position.copy(idLight.position);
  group.add(glow);

  const headlight = new THREE.SpotLight(0xbfe8f2, 110, 260, 0.42, 0.55, 1.5);
  headlight.position.set(0, -radius * 0.1, length * 0.46);
  const lens = addMesh(group, new THREE.CylinderGeometry(0.65 * k, 0.65 * k, 0.2 * k, 12), accent);
  lens.rotation.x = Math.PI / 2;
  lens.position.copy(headlight.position);
  const target = new THREE.Object3D();
  target.position.set(0, -8, length * 0.46 + 120);
  group.add(target);
  headlight.target = target;
  group.add(headlight);

  group.userData.role = role;
  return { group, propellers, rudders, divePlanes: divePlanePivots, sensors, repairArms, weaponDoors, idLight, headlight, role };
}
