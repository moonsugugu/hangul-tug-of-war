import * as THREE from 'three';

const TEAM_COLORS = {
  blue: 0x4e78f4,
  white: 0xffd36c,
};

const CHARACTER_STYLES = {
  rabbit: { body: 0xfff6f2, accent: 0xf29bb0, ears: 'long' },
  bear: { body: 0x9a684c, accent: 0xf0b66d, ears: 'round' },
  cat: { body: 0xf2a869, accent: 0xffd16b, ears: 'point' },
  chick: { body: 0xffe36e, accent: 0xff9a4e, ears: 'beak' },
  panda: { body: 0xf5f4ed, accent: 0x32333b, ears: 'round' },
  sheep: { body: 0xfff8e6, accent: 0xe8b6a4, ears: 'wool' },
  fox: { body: 0xf27a4b, accent: 0x633d36, ears: 'point' },
  penguin: { body: 0x3b4251, accent: 0xf6f0de, ears: 'beak' },
};

function material(color, roughness = 0.84) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
}

function shadow(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addMesh(group, geometry, color, position, scale = [1, 1, 1]) {
  const mesh = shadow(new THREE.Mesh(geometry, material(color)));
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  group.add(mesh);
  return mesh;
}

function addEye(group, x, y, z = 0.36) {
  addMesh(group, new THREE.SphereGeometry(0.052, 8, 8), 0x2f2b37, [x, y, z]);
}

function addEar(group, style, x, y) {
  if (style === 'long') {
    const ear = addMesh(group, new THREE.CapsuleGeometry(0.11, 0.34, 4, 8), 0xfff6f2, [x, y, 0.02], [1, 1.25, 0.75]);
    ear.rotation.z = x > 0 ? -0.18 : 0.18;
    addMesh(group, new THREE.CapsuleGeometry(0.04, 0.22, 4, 8), 0xf29bb0, [x, y - 0.01, 0.085], [1, 1.18, 0.4]);
    return;
  }

  if (style === 'point') {
    const ear = addMesh(group, new THREE.ConeGeometry(0.18, 0.42, 4), 0x633d36, [x, y, 0]);
    ear.rotation.y = Math.PI / 4;
    return;
  }

  if (style === 'round' || style === 'wool') {
    addMesh(group, new THREE.SphereGeometry(0.15, 10, 8), style === 'wool' ? 0xfff8e6 : 0x3a2f30, [x, y, 0]);
  }
}

function createCharacter(characterId, team, index) {
  const spec = CHARACTER_STYLES[characterId] || CHARACTER_STYLES.bear;
  const group = new THREE.Group();
  group.userData = { phase: index * 0.77 + Math.random() * 0.6, team };

  const body = addMesh(group, new THREE.CapsuleGeometry(0.28, 0.45, 5, 10), spec.body, [0, 0.78, 0], [1, 1.05, 0.82]);
  if (characterId === 'penguin') {
    addMesh(group, new THREE.SphereGeometry(0.18, 12, 8), spec.accent, [0, 0.8, 0.23], [1, 1.25, 0.28]);
  } else if (characterId === 'panda') {
    addMesh(group, new THREE.SphereGeometry(0.16, 10, 8), spec.accent, [-0.17, 1.04, 0.3], [1, 1.2, 0.3]);
    addMesh(group, new THREE.SphereGeometry(0.16, 10, 8), spec.accent, [0.17, 1.04, 0.3], [1, 1.2, 0.3]);
  }

  const head = addMesh(group, new THREE.SphereGeometry(0.34, 16, 12), spec.body, [0, 1.42, 0.03], [1.04, 0.95, 0.88]);
  addEar(group, spec.ears, -0.2, 1.7);
  addEar(group, spec.ears, 0.2, 1.7);
  addEye(group, -0.12, 1.48);
  addEye(group, 0.12, 1.48);

  if (spec.ears === 'beak') {
    const beak = addMesh(group, new THREE.ConeGeometry(0.1, 0.26, 8), spec.accent, [0, 1.4, 0.37]);
    beak.rotation.x = Math.PI / 2;
  }

  const scarf = addMesh(group, new THREE.TorusGeometry(0.29, 0.055, 6, 18), TEAM_COLORS[team], [0, 1.16, 0], [1, 1, 0.75]);
  scarf.rotation.x = Math.PI / 2;
  const scarfTail = addMesh(group, new THREE.BoxGeometry(0.1, 0.36, 0.04), TEAM_COLORS[team], [team === 'blue' ? -0.24 : 0.24, 1.02, 0.02]);
  scarfTail.rotation.z = team === 'blue' ? -0.2 : 0.2;

  const armGeometry = new THREE.CapsuleGeometry(0.07, 0.42, 4, 8);
  const armSide = team === 'blue' ? 1 : -1;
  const arm = addMesh(group, armGeometry, spec.body, [armSide * 0.38, 0.98, 0.02]);
  arm.rotation.z = team === 'blue' ? -0.95 : 0.95;
  addMesh(group, new THREE.SphereGeometry(0.09, 8, 8), 0xffc79d, [armSide * 0.54, 1.2, 0.03]);

  const legGeometry = new THREE.CapsuleGeometry(0.08, 0.26, 4, 8);
  addMesh(group, legGeometry, spec.accent, [-0.13, 0.36, 0]);
  addMesh(group, legGeometry, spec.accent, [0.13, 0.36, 0]);
  addMesh(group, new THREE.SphereGeometry(0.11, 8, 8), 0x57423f, [-0.16, 0.18, 0.06], [1.2, 0.65, 1.3]);
  addMesh(group, new THREE.SphereGeometry(0.11, 8, 8), 0x57423f, [0.16, 0.18, 0.06], [1.2, 0.65, 1.3]);

  group.userData.body = body;
  group.userData.head = head;
  return group;
}

function createTextSprite(text, color = '#3b3032', background = '#fff2c9') {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 120;
  const context = canvas.getContext('2d');
  context.fillStyle = background;
  context.roundRect(5, 5, 310, 110, 22);
  context.fill();
  context.strokeStyle = '#3b3032';
  context.lineWidth = 5;
  context.stroke();
  context.fillStyle = color;
  context.font = 'bold 42px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, 160, 60);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(2.25, 0.84, 1);
  return sprite;
}

function createJudge() {
  const group = new THREE.Group();
  addMesh(group, new THREE.CapsuleGeometry(0.55, 0.8, 6, 12), 0xc84437, [0, 0.92, 0.65], [1.05, 1, 0.7]);
  addMesh(group, new THREE.SphereGeometry(0.42, 16, 12), 0xffc79d, [0, 1.9, 0.65], [1, 1.05, 0.75]);
  addMesh(group, new THREE.CylinderGeometry(0.43, 0.5, 0.16, 12), 0x2f2b37, [0, 2.33, 0.65]);
  addMesh(group, new THREE.SphereGeometry(0.48, 12, 8), 0x2f2b37, [0, 2.38, 0.65], [1, 0.32, 0.75]);
  addEye(group, -0.14, 1.96, 0.97);
  addEye(group, 0.14, 1.96, 0.97);
  const board = createTextSprite('한글 힘내요!', '#3b3032', '#ffe6ae');
  board.position.set(0, 1.2, 1.25);
  board.scale.set(1.55, 0.58, 1);
  group.add(board);
  return group;
}

function addScenery(scene) {
  const ground = shadow(new THREE.Mesh(new THREE.PlaneGeometry(26, 18), material(0xe8bd7f)));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.35;
  scene.add(ground);

  const hillMaterial = material(0x64a36f);
  [-8, -4, 4, 8].forEach((x, index) => {
    const hill = shadow(new THREE.Mesh(new THREE.ConeGeometry(2.7 + index * 0.25, 3.5, 6), hillMaterial));
    hill.position.set(x, 1.2, -6.3);
    hill.rotation.y = index * 0.8;
    scene.add(hill);
  });

  const palace = new THREE.Group();
  addMesh(palace, new THREE.BoxGeometry(5, 1.25, 0.75), 0xf0d9aa, [0, 0.75, -5.1]);
  addMesh(palace, new THREE.BoxGeometry(5.5, 0.23, 1.25), 0x4e3e4d, [0, 1.52, -5.1], [1, 1, 0.9]);
  addMesh(palace, new THREE.BoxGeometry(2.3, 1.8, 0.8), 0xf4dfb4, [0, 1.45, -4.7]);
  addMesh(palace, new THREE.BoxGeometry(2.8, 0.25, 1.2), 0x463c4a, [0, 2.5, -4.7]);
  [-1, 1].forEach((x) => addMesh(palace, new THREE.CylinderGeometry(0.07, 0.07, 1.4, 8), 0xc65f49, [x * 1.02, 1.58, -4.23]));
  const sign = createTextSprite('세종대왕', '#fff6df', '#9d4236');
  sign.position.set(0, 1.7, -4.2);
  sign.scale.set(1.15, 0.42, 1);
  palace.add(sign);
  scene.add(palace);

  const poleMaterial = material(0x6f5038);
  [-9.2, 9.2].forEach((x, index) => {
    addMesh(scene, new THREE.CylinderGeometry(0.05, 0.07, 5.2, 8), 0x6f5038, [x, 2.15, -1.2]);
    addMesh(scene, new THREE.SphereGeometry(0.17, 10, 8), 0xf5bc58, [x, 4.78, -1.2]);
    const flag = addMesh(scene, new THREE.PlaneGeometry(1.65, 0.95), index === 0 ? TEAM_COLORS.blue : 0xfff8e6, [x + (index === 0 ? 0.75 : -0.75), 3.95, -1.2]);
    flag.rotation.y = index === 0 ? -0.08 : 0.08;
  });

  const bunting = new THREE.Group();
  const colors = [0x4e78f4, 0xf18b9b, 0xffd568, 0x72b8a2];
  for (let index = 0; index < 12; index += 1) {
    const flag = addMesh(bunting, new THREE.ConeGeometry(0.18, 0.55, 3), colors[index % colors.length], [-7.5 + index * 1.35, 4.75 - (index % 2) * 0.08, -1.3]);
    flag.rotation.z = Math.PI;
    flag.rotation.y = Math.PI / 2;
  }
  scene.add(bunting);
}

function createRope() {
  const group = new THREE.Group();
  const ropeMaterial = material(0xc18a4c);
  const knot = shadow(new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), material(0xffd568)));
  const ribbonBlue = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.08), material(TEAM_COLORS.blue)));
  const ribbonWhite = shadow(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.08), material(0xfff7e8)));
  ribbonBlue.position.set(-0.07, -0.1, 0.05);
  ribbonWhite.position.set(0.07, -0.1, 0.05);
  ribbonBlue.rotation.z = -0.25;
  ribbonWhite.rotation.z = 0.25;
  group.add(knot, ribbonBlue, ribbonWhite);
  group.userData.ropeMaterial = ropeMaterial;
  group.userData.knot = knot;
  group.userData.ribbonBlue = ribbonBlue;
  group.userData.ribbonWhite = ribbonWhite;
  group.userData.mesh = null;
  return group;
}

export function mountTugScene(container, data) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    container.innerHTML = '<div class="scene-fallback">3D 장면을 준비하지 못했어요. 게임은 계속 진행됩니다.</div>';
    return { dispose() {} };
  }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9edcff);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 4.2, 16.8);
  camera.lookAt(0, 1.45, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'three-canvas';
  renderer.domElement.setAttribute('aria-label', '세종대왕님이 심판하는 3D 줄다리기 장면');
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c6b55, 2.15));
  const sun = new THREE.DirectionalLight(0xfff2cf, 3.2);
  sun.position.set(-4, 8, 8);
  sun.castShadow = true;
  scene.add(sun);
  addScenery(scene);

  const rope = createRope();
  scene.add(rope);
  const judge = createJudge();
  judge.position.set(0, -0.24, 0.72);
  scene.add(judge);

  const teams = { blue: new THREE.Group(), white: new THREE.Group() };
  scene.add(teams.blue, teams.white);
  const roster = data.players || [];
  for (const team of ['blue', 'white']) {
    const teamPlayers = roster.filter((player) => player.team === team && !player.spectator);
    const gap = Math.min(0.95, 5.7 / Math.max(teamPlayers.length, 1));
    teamPlayers.forEach((player, index) => {
      const character = createCharacter(player.characterId, team, index);
      const offset = index - (teamPlayers.length - 1) / 2;
      const side = team === 'blue' ? -1 : 1;
      character.position.set(side * 6.9 - side * offset * gap, -0.12, 0.1 + Math.abs(offset) * 0.05);
      character.rotation.y = team === 'blue' ? -0.1 : Math.PI + 0.1;
      character.userData.baseX = character.position.x;
      character.userData.side = side;
      teams[team].add(character);
    });
  }

  const confetti = [];
  for (let index = 0; index < 24; index += 1) {
    const piece = addMesh(scene, new THREE.PlaneGeometry(0.08, 0.18), [0x4e78f4, 0xf18b9b, 0xffd568, 0x72b8a2][index % 4], [
      -9 + Math.random() * 18,
      1.3 + Math.random() * 4,
      -0.2 - Math.random() * 1.2,
    ]);
    piece.visible = false;
    piece.userData.phase = Math.random() * Math.PI * 2;
    confetti.push(piece);
  }

  let targetRopeX = ((Number(data.ropePosition || 50) - 50) / 50) * 4.7;
  let currentRopeX = targetRopeX;
  let ropeLastX = Number.NaN;
  let frame = 0;
  let animationId = 0;
  let disposed = false;

  function resize() {
    const width = Math.max(320, container.clientWidth || 800);
    const height = Math.max(260, container.clientHeight || 430);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function updateRope(time) {
    const wave = Math.sin(time * 0.003) * 0.07;
    if (Math.abs(currentRopeX - ropeLastX) > 0.025 || Number.isNaN(ropeLastX)) {
      const points = [
        new THREE.Vector3(-8.2, 1.22 + wave * 0.35, 0.36),
        new THREE.Vector3(-5.4, 1.29 - wave, 0.38),
        new THREE.Vector3(currentRopeX, 1.31 + wave * 1.4, 0.45),
        new THREE.Vector3(5.4, 1.29 + wave, 0.38),
        new THREE.Vector3(8.2, 1.22 - wave * 0.35, 0.36),
      ];
      const curve = new THREE.CatmullRomCurve3(points);
      const geometry = new THREE.TubeGeometry(curve, 36, 0.1, 7, false);
      if (rope.userData.mesh) {
        rope.userData.mesh.geometry.dispose();
        rope.remove(rope.userData.mesh);
      }
      rope.userData.mesh = shadow(new THREE.Mesh(geometry, rope.userData.ropeMaterial));
      rope.add(rope.userData.mesh);
      rope.userData.knot.position.set(currentRopeX, 1.32 + wave * 1.4, 0.55);
      rope.userData.ribbonBlue.position.x = currentRopeX - 0.07;
      rope.userData.ribbonWhite.position.x = currentRopeX + 0.07;
      rope.userData.knot.position.z = 0.55;
      rope.userData.ribbonBlue.position.z = 0.59;
      rope.userData.ribbonWhite.position.z = 0.59;
      ropeLastX = currentRopeX;
    }
  }

  function animate(time) {
    if (disposed) return;
    animationId = requestAnimationFrame(animate);
    frame += 1;
    currentRopeX = THREE.MathUtils.lerp(currentRopeX, targetRopeX, 0.055);
    updateRope(time);
    const tug = Math.sin(time * 0.004) * 0.045;
    for (const team of ['blue', 'white']) {
      teams[team].children.forEach((character, index) => {
        const side = character.userData.side;
        character.rotation.z = side * (-0.1 + tug + Math.sin(time * 0.003 + character.userData.phase) * 0.035);
        character.position.x = character.userData.baseX + side * Math.sin(time * 0.004 + index) * 0.055;
        character.position.y = -0.12 + Math.sin(time * 0.005 + character.userData.phase) * 0.035;
      });
    }
    judge.rotation.y = Math.sin(time * 0.0014) * 0.04;
    judge.position.y = -0.24 + Math.sin(time * 0.002) * 0.035;
    confetti.forEach((piece, index) => {
      if (frame < 1) return;
      piece.visible = data.phase === 'results';
      piece.rotation.z += 0.018 + index * 0.0003;
      piece.position.y -= 0.003;
      if (piece.position.y < 0) piece.position.y = 4.5 + Math.sin(piece.userData.phase) * 0.8;
    });
    renderer.render(scene, camera);
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  animationId = requestAnimationFrame(animate);

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(animationId);
      observer.disconnect();
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((item) => {
            if (item.map) item.map.dispose();
            item.dispose();
          });
        }
      });
      renderer.dispose();
    },
    update(nextData) {
      targetRopeX = ((Number(nextData.ropePosition || 50) - 50) / 50) * 4.7;
    },
  };
}
