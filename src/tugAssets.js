import * as THREE from 'three';

export const TEAM_COLORS = {
  blue: 0x3f70e8,
  white: 0xfff4d9,
};

const COLORS = {
  ink: 0x302a38,
  skin: 0xffc59f,
  skinLight: 0xffd9bc,
  red: 0xc9483d,
  redDark: 0x923936,
  roof: 0x514351,
  roofLight: 0x6c5a68,
  palace: 0xf3d59f,
  palaceLight: 0xffe6b4,
  ground: 0xe9bd7d,
  grass: 0x65a466,
  grassLight: 0x86c275,
  rope: 0xc58b4e,
  ropeLight: 0xf1c889,
};

const CHARACTER_STYLES = {
  rabbit: { body: 0xfff8f2, accent: 0xf39bb3, ear: 'long', cheek: 0xffb0bd },
  bear: { body: 0x9b674b, accent: 0xeab16e, ear: 'round', cheek: 0xf29e89 },
  cat: { body: 0xf1a565, accent: 0xffd46d, ear: 'point', cheek: 0xf3a18b },
  chick: { body: 0xffe16b, accent: 0xf49a4d, ear: 'beak', cheek: 0xf2a15f },
  panda: { body: 0xf6f3e9, accent: 0x363641, ear: 'round', cheek: 0xf4a9b4 },
  sheep: { body: 0xfff6e2, accent: 0xe4b0a1, ear: 'wool', cheek: 0xf2b2ad },
  fox: { body: 0xf47c49, accent: 0x703c36, ear: 'point', cheek: 0xf2a080 },
  penguin: { body: 0x3c4658, accent: 0xf7efd9, ear: 'beak', cheek: 0xf0a8a0 },
};

function toonMaterial(color, options = {}) {
  return new THREE.MeshToonMaterial({ color, ...options });
}

function standardMaterial(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.01, ...options });
}

function shadow(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addMesh(group, geometry, color, position, scale = [1, 1, 1], options = {}) {
  const mesh = shadow(new THREE.Mesh(geometry, options.standard ? standardMaterial(color, options) : toonMaterial(color, options)));
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  group.add(mesh);
  return mesh;
}

function addEye(group, x, y, z = 0.46, scale = [1, 1, 1]) {
  const eye = addMesh(group, new THREE.SphereGeometry(0.055, 10, 8), COLORS.ink, [x, y, z], scale);
  addMesh(group, new THREE.SphereGeometry(0.018, 8, 6), 0xffffff, [x - 0.018, y + 0.02, z + 0.05]);
  return eye;
}

function addCheek(group, x, y, color) {
  addMesh(group, new THREE.SphereGeometry(0.075, 10, 8), color, [x, y, 0.45], [1.2, 0.62, 0.2]);
}

function addEar(group, style, color, accent, x, y) {
  if (style === 'long') {
    const ear = addMesh(group, new THREE.CapsuleGeometry(0.105, 0.38, 5, 9), color, [x, y, 0.04], [1, 1.32, 0.72]);
    ear.rotation.z = x > 0 ? -0.14 : 0.14;
    const inner = addMesh(group, new THREE.CapsuleGeometry(0.038, 0.25, 5, 8), accent, [x, y - 0.01, 0.12], [1, 1.18, 0.35]);
    inner.rotation.z = ear.rotation.z;
    return;
  }

  if (style === 'point') {
    const ear = addMesh(group, new THREE.ConeGeometry(0.18, 0.45, 4), color, [x, y, 0.01]);
    ear.rotation.y = Math.PI / 4;
    addMesh(group, new THREE.ConeGeometry(0.08, 0.27, 4), accent, [x, y - 0.01, 0.16]);
    return;
  }

  if (style === 'wool') {
    [-0.22, 0.22].forEach((offset) => {
      addMesh(group, new THREE.SphereGeometry(0.18, 10, 8), color, [x + offset, y, 0]);
    });
    return;
  }

  addMesh(group, new THREE.SphereGeometry(0.16, 10, 8), style === 'round' ? accent : color, [x, y, 0]);
}

function addHeadband(group, team) {
  const band = addMesh(group, new THREE.TorusGeometry(0.39, 0.045, 8, 24), TEAM_COLORS[team], [0, 1.47, 0.02]);
  band.rotation.x = Math.PI / 2;
  const knot = addMesh(group, new THREE.SphereGeometry(0.08, 8, 6), TEAM_COLORS[team], [team === 'blue' ? -0.36 : 0.36, 1.47, 0.04], [1.25, 0.75, 0.55]);
  const tail = addMesh(group, new THREE.BoxGeometry(0.06, 0.24, 0.025), TEAM_COLORS[team], [team === 'blue' ? -0.46 : 0.46, 1.34, 0.03]);
  tail.rotation.z = team === 'blue' ? -0.28 : 0.28;
  return band;
}

function addAnimalFace(group, characterId, spec) {
  if (characterId === 'penguin') {
    addMesh(group, new THREE.SphereGeometry(0.19, 12, 8), spec.accent, [0, 1.02, 0.34], [1, 1.25, 0.25]);
    addMesh(group, new THREE.ConeGeometry(0.105, 0.25, 8), 0xf3a44e, [0, 1.39, 0.5]);
    group.children.at(-1).rotation.x = Math.PI / 2;
  } else if (characterId === 'panda') {
    addMesh(group, new THREE.SphereGeometry(0.15, 10, 8), spec.accent, [-0.17, 1.48, 0.35], [1, 1.1, 0.35]);
    addMesh(group, new THREE.SphereGeometry(0.15, 10, 8), spec.accent, [0.17, 1.48, 0.35], [1, 1.1, 0.35]);
  } else if (characterId === 'chick') {
    addMesh(group, new THREE.ConeGeometry(0.1, 0.25, 8), spec.accent, [0, 1.4, 0.47]);
    group.children.at(-1).rotation.x = Math.PI / 2;
    addMesh(group, new THREE.ConeGeometry(0.11, 0.22, 4), spec.accent, [0, 1.78, 0.03]);
  } else if (characterId === 'fox') {
    addMesh(group, new THREE.SphereGeometry(0.09, 8, 6), 0xffead7, [0, 1.37, 0.46], [1.7, 0.9, 0.34]);
  }

  addEye(group, -0.12, 1.49);
  addEye(group, 0.12, 1.49);
  addCheek(group, -0.23, 1.35, spec.cheek);
  addCheek(group, 0.23, 1.35, spec.cheek);
}

export function createCharacterAsset(characterId, team, index = 0) {
  const spec = CHARACTER_STYLES[characterId] || CHARACTER_STYLES.bear;
  const group = new THREE.Group();
  group.name = `character-${characterId}-${team}-${index}`;
  group.userData = { phase: index * 0.77 + Math.random() * 0.6, team, characterId };

  const body = addMesh(group, new THREE.CapsuleGeometry(0.32, 0.48, 6, 12), spec.body, [0, 0.78, 0], [1.08, 1.05, 0.86]);
  body.rotation.z = team === 'blue' ? -0.1 : 0.1;
  if (characterId === 'penguin') {
    addMesh(group, new THREE.SphereGeometry(0.2, 12, 8), spec.accent, [0, 0.82, 0.29], [1, 1.3, 0.25]);
  }

  const head = addMesh(group, new THREE.SphereGeometry(0.4, 16, 12), spec.body, [0, 1.43, 0.02], [1.08, 0.98, 0.9]);
  head.rotation.z = team === 'blue' ? -0.04 : 0.04;
  addEar(group, spec.ear, spec.body, spec.accent, -0.23, 1.73);
  addEar(group, spec.ear, spec.body, spec.accent, 0.23, 1.73);
  addAnimalFace(group, characterId, spec);
  addHeadband(group, team);

  const armSide = team === 'blue' ? 1 : -1;
  const arm = addMesh(group, new THREE.CapsuleGeometry(0.075, 0.46, 5, 8), spec.body, [armSide * 0.42, 1.01, 0.12]);
  arm.rotation.z = team === 'blue' ? -1.03 : 1.03;
  addMesh(group, new THREE.SphereGeometry(0.105, 10, 8), COLORS.skin, [armSide * 0.6, 1.23, 0.23]);

  const leg = new THREE.CapsuleGeometry(0.09, 0.28, 5, 8);
  addMesh(group, leg, spec.accent, [-0.15, 0.34, 0.01]);
  addMesh(group, leg, spec.accent, [0.15, 0.34, 0.01]);
  addMesh(group, new THREE.SphereGeometry(0.12, 10, 8), COLORS.ink, [-0.18, 0.17, 0.1], [1.35, 0.65, 1.35]);
  addMesh(group, new THREE.SphereGeometry(0.12, 10, 8), COLORS.ink, [0.18, 0.17, 0.1], [1.35, 0.65, 1.35]);

  if (characterId === 'fox' || characterId === 'cat') {
    const tail = addMesh(group, new THREE.SphereGeometry(0.24, 10, 8), spec.body, [team === 'blue' ? -0.38 : 0.38, 0.72, -0.18], [1.4, 0.9, 0.55]);
    tail.rotation.z = team === 'blue' ? -0.35 : 0.35;
    addMesh(group, new THREE.SphereGeometry(0.1, 8, 6), spec.accent, [team === 'blue' ? -0.58 : 0.58, 0.78, -0.2]);
  }

  group.scale.setScalar(1.18);
  group.userData.body = body;
  group.userData.head = head;
  return group;
}

function createTextSprite(text, color = '#3b3032', background = '#fff2c9', width = 320, height = 120) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = background;
  context.beginPath();
  if (context.roundRect) context.roundRect(5, 5, width - 10, height - 10, 22);
  else context.rect(5, 5, width - 10, height - 10);
  context.fill();
  context.strokeStyle = '#3b3032';
  context.lineWidth = 5;
  context.stroke();
  context.fillStyle = color;
  context.font = `bold ${Math.round(height * 0.36)}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(width / 145, height / 143, 1);
  return sprite;
}

function addCloud(scene, x, y, z, scale = 1) {
  const cloud = new THREE.Group();
  [
    [-0.48, 0, 0, 0.35],
    [-0.12, 0.13, 0, 0.48],
    [0.28, 0.04, 0, 0.4],
    [0.58, -0.01, 0, 0.28],
  ].forEach(([cx, cy, cz, radius]) => addMesh(cloud, new THREE.SphereGeometry(radius, 10, 8), 0xffffff, [cx, cy, cz], [1.2, 0.78, 0.45]));
  cloud.position.set(x, y, z);
  cloud.scale.setScalar(scale);
  scene.add(cloud);
}

function addRoof(group, width, y, z, scale = 1) {
  const roof = addMesh(group, new THREE.BoxGeometry(width, 0.2, 1.1), COLORS.roof, [0, y, z], [scale, 1, 1]);
  roof.rotation.z = 0.02;
  addMesh(group, new THREE.BoxGeometry(width * 0.88, 0.1, 0.85), COLORS.roofLight, [0, y + 0.16, z + 0.05], [scale, 1, 1]);
  for (let index = -4; index <= 4; index += 1) {
    addMesh(group, new THREE.CylinderGeometry(0.045, 0.045, 0.72, 7), COLORS.roofLight, [index * (width / 9) * 0.92, y + 0.12, z + 0.18], [1, 1, 0.6]);
  }
}

function addSmallPerson(group, x, y, z, palette, index) {
  const person = new THREE.Group();
  addMesh(person, new THREE.CapsuleGeometry(0.12, 0.2, 4, 7), palette[index % palette.length], [0, 0.25, 0]);
  addMesh(person, new THREE.SphereGeometry(0.14, 8, 6), COLORS.skinLight, [0, 0.57, 0]);
  addMesh(person, new THREE.CylinderGeometry(0.14, 0.17, 0.08, 8), COLORS.ink, [0, 0.73, 0]);
  person.position.set(x, y, z);
  person.rotation.z = (index % 2 ? -1 : 1) * 0.04;
  person.scale.setScalar(0.9 + (index % 3) * 0.08);
  group.add(person);
}

export function addCrowdAndSigns(scene) {
  const crowd = new THREE.Group();
  const palette = [0x4e78f4, 0xc84d46, 0x73a979, 0xf0ad58, 0x8e6ad5];
  const positions = [-7.4, -6.2, -5.05, -3.85, -2.65, -1.45, 1.45, 2.65, 3.85, 5.05, 6.2, 7.4];
  positions.forEach((x, index) => addSmallPerson(crowd, x, 0.55 + (index % 2) * 0.12, -2.35, palette, index));
  positions.slice(1, -1).forEach((x, index) => addSmallPerson(crowd, x + 0.22, 0.65 + (index % 2) * 0.1, -2.7, palette, index + 12));
  scene.add(crowd);

  const signs = [
    ['파이팅!', -7.2, 2.2, 0x4e78f4],
    ['할 수 있다!', -6.25, 1.55, 0xfff1cd],
    ['끝까지 힘내!', 6.25, 1.65, 0xfff1cd],
    ['우리도 할 수 있다!', 7.15, 2.2, 0xfff8ee],
  ];
  signs.forEach(([text, x, y, color], index) => {
    const sign = createTextSprite(text, index === 0 ? '#ffffff' : '#4c3737', `#${color.toString(16).padStart(6, '0')}`, 310, 112);
    sign.position.set(x, y, -1.8);
    sign.scale.set(1.15, 0.43, 1);
    sign.rotation.z = (index % 2 ? -0.05 : 0.05);
    scene.add(sign);
  });
}

export function addStageAssets(scene) {
  const ground = shadow(new THREE.Mesh(new THREE.PlaneGeometry(25, 18), standardMaterial(COLORS.ground)));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.36;
  scene.add(ground);

  const grass = shadow(new THREE.Mesh(new THREE.PlaneGeometry(25, 2.2), standardMaterial(COLORS.grass)));
  grass.rotation.x = -Math.PI / 2;
  grass.position.set(0, -0.34, -2.8);
  scene.add(grass);

  const hills = new THREE.Group();
  [-8.5, -6.1, -3.7, 3.7, 6.1, 8.5].forEach((x, index) => {
    const hill = addMesh(hills, new THREE.ConeGeometry(1.7 + (index % 3) * 0.25, 2.8 + (index % 2) * 0.45, 6), index % 2 ? COLORS.grassLight : COLORS.grass, [x, 1.05, -5.9]);
    hill.rotation.y = index * 0.55;
  });
  scene.add(hills);

  const palace = new THREE.Group();
  addMesh(palace, new THREE.BoxGeometry(6.6, 1.3, 0.78), COLORS.palace, [0, 0.72, -4.9]);
  addMesh(palace, new THREE.BoxGeometry(2.7, 1.7, 0.9), COLORS.palaceLight, [0, 1.36, -4.48]);
  addRoof(palace, 7.1, 1.55, -4.88, 1);
  addRoof(palace, 3.25, 2.5, -4.47, 1);
  [-2.5, -1.35, 1.35, 2.5].forEach((x) => {
    addMesh(palace, new THREE.CylinderGeometry(0.075, 0.085, 1.45, 8), COLORS.redDark, [x, 1.0, -4.35]);
  });
  addMesh(palace, new THREE.BoxGeometry(0.95, 1.05, 0.1), COLORS.roof, [0, 0.7, -4.0]);
  const sign = createTextSprite('세종대왕', '#fff5d9', '#9b4038', 290, 110);
  sign.position.set(0, 1.75, -4.0);
  sign.scale.set(1.28, 0.43, 1);
  palace.add(sign);
  scene.add(palace);

  addCloud(scene, -6.3, 4.05, -5.4, 1.1);
  addCloud(scene, 5.8, 4.3, -5.2, 0.9);

  const poleGroup = new THREE.Group();
  [-8.6, 8.6].forEach((x, index) => {
    addMesh(poleGroup, new THREE.CylinderGeometry(0.055, 0.075, 4.4, 8), 0x76523d, [x, 2.0, -1.05]);
    addMesh(poleGroup, new THREE.SphereGeometry(0.15, 10, 8), 0xf3bc58, [x, 4.25, -1.05]);
    const flag = addMesh(poleGroup, new THREE.PlaneGeometry(1.65, 0.9), index === 0 ? TEAM_COLORS.blue : TEAM_COLORS.white, [x + (index === 0 ? 0.76 : -0.76), 3.55, -1.05]);
    flag.rotation.y = index === 0 ? -0.1 : 0.1;
  });
  scene.add(poleGroup);

  const bunting = new THREE.Group();
  const buntingColors = [0x4e78f4, 0xf18b9b, 0xffd568, 0x72b8a2];
  for (let index = 0; index < 13; index += 1) {
    const flag = addMesh(bunting, new THREE.ConeGeometry(0.16, 0.46, 3), buntingColors[index % buntingColors.length], [-7.7 + index * 1.28, 4.28 - (index % 2) * 0.08, -1.25]);
    flag.rotation.z = Math.PI;
    flag.rotation.y = Math.PI / 2;
  }
  scene.add(bunting);
  addCrowdAndSigns(scene);
}

export function createJudgeAsset() {
  const group = new THREE.Group();
  group.name = 'sejong-judge';
  addMesh(group, new THREE.CapsuleGeometry(0.58, 0.86, 7, 13), COLORS.red, [0, 0.95, 0.7], [1.1, 1.05, 0.74]);
  addMesh(group, new THREE.BoxGeometry(0.56, 0.12, 0.48), COLORS.redDark, [0, 0.74, 0.77]);
  addMesh(group, new THREE.SphereGeometry(0.43, 16, 12), COLORS.skin, [0, 1.88, 0.7], [1, 1.06, 0.76]);
  addMesh(group, new THREE.CylinderGeometry(0.46, 0.55, 0.13, 14), COLORS.ink, [0, 2.34, 0.7]);
  addMesh(group, new THREE.SphereGeometry(0.48, 12, 8), COLORS.ink, [0, 2.38, 0.7], [1, 0.35, 0.76]);
  addMesh(group, new THREE.SphereGeometry(0.28, 12, 8), COLORS.ink, [0, 1.68, 0.97], [1, 1.15, 0.38]);
  addMesh(group, new THREE.TorusGeometry(0.16, 0.035, 6, 14), COLORS.ink, [0, 1.78, 1.0], [1.4, 0.8, 0.4]);
  addEye(group, -0.14, 1.95, 1.02);
  addEye(group, 0.14, 1.95, 1.02);

  const arm = addMesh(group, new THREE.CapsuleGeometry(0.09, 0.58, 5, 8), COLORS.red, [-0.64, 1.23, 0.66]);
  arm.rotation.z = -0.95;
  addMesh(group, new THREE.SphereGeometry(0.12, 10, 8), COLORS.skin, [-0.9, 1.52, 0.7]);
  const board = createTextSprite('한글 힘내요!', '#3b3032', '#ffe6ae', 350, 120);
  board.position.set(0.03, 1.12, 1.24);
  board.scale.set(1.42, 0.5, 1);
  group.add(board);
  group.userData.board = board;
  return group;
}

export function createRopeAsset() {
  const group = new THREE.Group();
  group.name = 'braided-rope';
  group.userData.ropeMaterial = standardMaterial(COLORS.rope, { roughness: 0.92 });
  const knot = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), toonMaterial(0xffd568)));
  const ribbonBlue = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.62, 0.09), toonMaterial(TEAM_COLORS.blue)));
  const ribbonWhite = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.62, 0.09), toonMaterial(0xfff8ea)));
  ribbonBlue.rotation.z = -0.25;
  ribbonWhite.rotation.z = 0.25;
  group.add(knot, ribbonBlue, ribbonWhite);
  group.userData.knot = knot;
  group.userData.ribbonBlue = ribbonBlue;
  group.userData.ribbonWhite = ribbonWhite;
  group.userData.mesh = null;
  return group;
}

export function createConfetti(scene) {
  const pieces = [];
  const colors = [0x4e78f4, 0xf18b9b, 0xffd568, 0x72b8a2];
  for (let index = 0; index < 30; index += 1) {
    const piece = addMesh(scene, new THREE.PlaneGeometry(0.08, 0.18), colors[index % colors.length], [-9 + Math.random() * 18, 1.7 + Math.random() * 3.4, -0.2 - Math.random() * 1.2]);
    piece.visible = false;
    piece.userData.phase = Math.random() * Math.PI * 2;
    pieces.push(piece);
  }
  return pieces;
}
