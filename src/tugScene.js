import * as THREE from 'three';
import {
  addStageAssets,
  createCharacterAsset,
  createConfetti,
  createJudgeAsset,
  createRopeAsset,
} from './tugAssets.js';

function shadow(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
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
  const camera = new THREE.PerspectiveCamera(29, 1, 0.1, 100);
  camera.position.set(0, 3.25, 14.4);
  camera.lookAt(0, 1.55, -0.9);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.className = 'three-canvas';
  renderer.domElement.setAttribute('aria-label', '세종대왕님이 심판하는 그림풍 3D 줄다리기 장면');
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c6b55, 2.35));
  const sun = new THREE.DirectionalLight(0xfff2cf, 3.6);
  sun.position.set(-4, 8, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);
  addStageAssets(scene);

  const rope = createRopeAsset();
  scene.add(rope);
  const judge = createJudgeAsset();
  judge.position.set(0, -0.3, 0.82);
  judge.scale.setScalar(1.05);
  scene.add(judge);

  const teams = { blue: new THREE.Group(), white: new THREE.Group() };
  teams.blue.name = 'blue-team-characters';
  teams.white.name = 'white-team-characters';
  scene.add(teams.blue, teams.white);

  const roster = data.players || [];
  for (const team of ['blue', 'white']) {
    const teamPlayers = roster.filter((player) => player.team === team && !player.spectator);
    const gap = Math.min(1.16, 6.25 / Math.max(teamPlayers.length, 1));
    teamPlayers.forEach((player, index) => {
      const character = createCharacterAsset(player.characterId, team, index);
      const offset = index - (teamPlayers.length - 1) / 2;
      const side = team === 'blue' ? -1 : 1;
      character.position.set(side * 5.8 - side * offset * gap, -0.09, 0.45 + Math.abs(offset) * 0.08);
      character.userData.baseX = character.position.x;
      character.userData.side = side;
      teams[team].add(character);
    });
  }

  const confetti = createConfetti(scene);
  let targetRopeX = ((Number(data.ropePosition || 50) - 50) / 50) * 3.9;
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
    const wave = Math.sin(time * 0.0032) * 0.075;
    if (Math.abs(currentRopeX - ropeLastX) > 0.018 || Number.isNaN(ropeLastX)) {
      const points = [
        new THREE.Vector3(-7.65, 1.2 + wave * 0.32, 0.44),
        new THREE.Vector3(-5.2, 1.25 - wave, 0.5),
        new THREE.Vector3(currentRopeX, 1.29 + wave * 1.4, 0.58),
        new THREE.Vector3(5.2, 1.25 + wave, 0.5),
        new THREE.Vector3(7.65, 1.2 - wave * 0.32, 0.44),
      ];
      const curve = new THREE.CatmullRomCurve3(points);
      const geometry = new THREE.TubeGeometry(curve, 48, 0.105, 9, false);
      if (rope.userData.mesh) {
        rope.userData.mesh.geometry.dispose();
        rope.remove(rope.userData.mesh);
      }
      rope.userData.mesh = shadow(new THREE.Mesh(geometry, rope.userData.ropeMaterial));
      rope.add(rope.userData.mesh);
      rope.userData.knot.position.set(currentRopeX, 1.3 + wave * 1.4, 0.7);
      rope.userData.ribbonBlue.position.set(currentRopeX - 0.075, 1.02 + wave * 1.4, 0.73);
      rope.userData.ribbonWhite.position.set(currentRopeX + 0.075, 1.02 + wave * 1.4, 0.73);
      ropeLastX = currentRopeX;
    }
  }

  function animate(time) {
    if (disposed) return;
    animationId = requestAnimationFrame(animate);
    frame += 1;
    currentRopeX = THREE.MathUtils.lerp(currentRopeX, targetRopeX, 0.06);
    updateRope(time);

    const tug = Math.sin(time * 0.004) * 0.055;
    for (const team of ['blue', 'white']) {
      teams[team].children.forEach((character, index) => {
        const side = character.userData.side;
        character.rotation.z = side * (-0.08 + tug + Math.sin(time * 0.003 + character.userData.phase) * 0.045);
        character.position.x = character.userData.baseX + side * Math.sin(time * 0.004 + index) * 0.085;
        character.position.y = -0.09 + Math.sin(time * 0.005 + character.userData.phase) * 0.04;
      });
    }

    judge.rotation.y = Math.sin(time * 0.0014) * 0.045;
    judge.position.y = -0.3 + Math.sin(time * 0.002) * 0.04;
    if (judge.userData.board) judge.userData.board.position.x = Math.sin(time * 0.002) * 0.025;

    confetti.forEach((piece, index) => {
      if (frame < 1) return;
      piece.visible = data.phase === 'results';
      piece.rotation.z += 0.018 + index * 0.0003;
      piece.position.y -= 0.003;
      if (piece.position.y < 0) piece.position.y = 4.8 + Math.sin(piece.userData.phase) * 0.8;
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
      targetRopeX = ((Number(nextData.ropePosition || 50) - 50) / 50) * 3.9;
    },
  };
}
