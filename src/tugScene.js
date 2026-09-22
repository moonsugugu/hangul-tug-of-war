import * as THREE from 'three';

const ASSET_ROOT = '/assets';
const ASSET_URLS = {
  arena: `${ASSET_ROOT}/palace-arena.png`,
  blueMascots: `${ASSET_ROOT}/blue-mascots.png`,
  whiteMascots: `${ASSET_ROOT}/white-mascots.png`,
  props: `${ASSET_ROOT}/tug-props.png`,
  stickers: `${ASSET_ROOT}/festival-stickers.png`,
  cheerleaders: `${ASSET_ROOT}/joseon-cheerleaders.png`,
  chibi: `${ASSET_ROOT}/chibi-poses.png`,
};

const imageCache = new Map();
const CHARACTER_ROWS = {
  rabbit: 0,
  bear: 0,
  cat: 3,
  chick: 1,
  panda: 0,
  sheep: 2,
  fox: 3,
  penguin: 1,
};

function loadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`에셋을 불러오지 못했어요: ${url}`));
    image.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

function gridRect(image, columns, rows, column, row, inset = 0) {
  const cellWidth = image.naturalWidth / columns;
  const cellHeight = image.naturalHeight / rows;
  return {
    x: Math.round(column * cellWidth + inset),
    y: Math.round(row * cellHeight + inset),
    w: Math.round(cellWidth - inset * 2),
    h: Math.round(cellHeight - inset * 2),
  };
}

function cropTexture(image, rect) {
  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, rect.w, rect.h);
  context.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function fullTexture(image) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function makeSprite(texture, width, height, scale = 1, z = 0) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(width * scale, height * scale, 1);
  sprite.position.z = z;
  return sprite;
}

function addCroppedSprite(parent, image, rect, pixelUnit, scale, position, z) {
  const texture = cropTexture(image, rect);
  const sprite = makeSprite(texture, rect.w * pixelUnit, rect.h * pixelUnit, scale, z);
  sprite.position.set(...position);
  parent?.add(sprite);
  return sprite;
}

function addFullImagePlane(scene, image, viewWidth, viewHeight) {
  const texture = fullTexture(image);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: false, depthTest: false, depthWrite: false });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  plane.position.set(0, -0.08, -5);
  plane.renderOrder = -10;
  plane.userData.imageAspect = image.naturalWidth / image.naturalHeight;
  plane.userData.resize = (width, height) => {
    const imageAspect = plane.userData.imageAspect;
    const coverWidth = Math.max(width, height * imageAspect);
    const coverHeight = coverWidth / imageAspect;
    plane.scale.set(coverWidth, coverHeight, 1);
  };
  plane.userData.resize(viewWidth, viewHeight);
  scene.add(plane);
  return plane;
}

function createRope(images, pixelUnit) {
  // The second rope row includes the blue-and-white center ribbon from the supplied prop sheet.
  const rope = addCroppedSprite(null, images.props, { x: 18, y: 137, w: 1040, h: 175 }, pixelUnit, 0.88, [0, -0.55, 1.32], 1.32);
  rope.name = 'supplied-braided-rope';
  return rope;
}

function createCharacters(scene, images, data, pixelUnit) {
  const characters = [];
  const sheetInfo = {
    blue: { image: images.blueMascots, columns: 5, rows: 4, tugColumn: 3, cheerColumn: 4 },
    white: { image: images.whiteMascots, columns: 6, rows: 4, tugColumn: 4, cheerColumn: 5 },
  };

  for (const team of ['blue', 'white']) {
    const players = (data.players || []).filter((player) => player.team === team && !player.spectator);
    const side = team === 'blue' ? -1 : 1;
    const info = sheetInfo[team];
    const gap = Math.min(1.45, 5.2 / Math.max(players.length, 1));

    players.forEach((player, index) => {
      const offset = index - (players.length - 1) / 2;
      const row = CHARACTER_ROWS[player.characterId] ?? 0;
      const baseX = side * 4.75 - side * offset * gap;
      const baseY = -1.1 + (index % 2) * 0.08;
      const tugRect = gridRect(info.image, info.columns, info.rows, info.tugColumn, row, 3);
      const cheerRect = gridRect(info.image, info.columns, info.rows, info.cheerColumn, row, 3);
      const tug = addCroppedSprite(scene, info.image, tugRect, pixelUnit, 0.86, [baseX, baseY, 1.12], 1.12);
      const cheer = addCroppedSprite(scene, info.image, cheerRect, pixelUnit, 0.86, [baseX, baseY, 1.12], 1.12);
      cheer.visible = false;
      tug.name = `${team}-${player.characterId}-tug`;
      cheer.name = `${team}-${player.characterId}-cheer`;
      characters.push({ tug, cheer, baseX, baseY, side, phase: index * 0.8 + Math.random() * 0.8 });
    });
  }
  return characters;
}

function createJudge(scene, images, pixelUnit) {
  const front = addCroppedSprite(scene, images.chibi, gridRect(images.chibi, 5, 5, 0, 0, 3), pixelUnit, 1.02, [0, -0.56, 1.22], 1.22);
  front.name = 'sejong-judge-sprite';
  return front;
}

function createCheerleaders(scene, images, pixelUnit) {
  const cheerleaders = [];
  const positions = [
    [-5.95, -0.25, 0.64, 1],
    [-3.1, -0.18, 0.58, 3],
    [3.1, -0.18, 0.58, 4],
    [5.95, -0.25, 0.64, 2],
  ];
  positions.forEach(([x, y, scale, column], index) => {
    const sprite = addCroppedSprite(scene, images.cheerleaders, gridRect(images.cheerleaders, 6, 3, column, index % 2, 3), pixelUnit, scale, [x, y, 0.25], 0.25);
    sprite.name = `joseon-cheerleader-${index}`;
    cheerleaders.push({ sprite, phase: index * 0.7 });
  });
  return cheerleaders;
}

function createTeamBanners(scene, images, pixelUnit) {
  const blueFlag = addCroppedSprite(scene, images.stickers, { x: 7, y: 5, w: 392, h: 424 }, pixelUnit, 0.34, [-5.85, 1.2, -1.1], -1.1);
  const whiteFlag = addCroppedSprite(scene, images.stickers, { x: 396, y: 5, w: 390, h: 424 }, pixelUnit, 0.34, [5.85, 1.2, -1.1], -1.1);
  blueFlag.name = 'blue-supplied-banner';
  whiteFlag.name = 'white-supplied-banner';
  return [blueFlag, whiteFlag];
}

function createDust(scene, images, pixelUnit) {
  const dust = addCroppedSprite(scene, images.props, { x: 295, y: 420, w: 330, h: 205 }, pixelUnit, 0.72, [0, -1.48, 1.24], 1.24);
  dust.name = 'tug-dust-effect';
  dust.material.opacity = 0.72;
  dust.visible = false;
  return dust;
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
  const camera = new THREE.OrthographicCamera(-7, 7, 3.2, -3.2, 0.1, 20);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'three-canvas';
  renderer.domElement.setAttribute('aria-label', '제공된 궁궐과 캐릭터 에셋으로 만든 2.5D 줄다리기 장면');
  container.appendChild(renderer.domElement);

  const loaded = Promise.all(Object.entries(ASSET_URLS).map(async ([key, url]) => [key, await loadImage(url)])).then((entries) => Object.fromEntries(entries));
  let disposed = false;
  let animationId = 0;
  let resizeObserver;
  let targetRopeX = ((Number(data.ropePosition || 50) - 50) / 50) * 2.65;
  let currentRopeX = targetRopeX;
  let rope;
  let dust;
  let characters = [];
  let cheerleaders = [];
  let background;
  let built = false;

  function resize() {
    const width = Math.max(320, container.clientWidth || 800);
    const height = Math.max(260, container.clientHeight || 430);
    const viewHeight = 6.4;
    const viewWidth = viewHeight * (width / height);
    camera.left = -viewWidth / 2;
    camera.right = viewWidth / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    if (background?.userData.resize) background.userData.resize(viewWidth, viewHeight);
  }

  loaded.then((images) => {
    if (disposed) return;
    const pixelUnit = 13.8 / 1448;
    background = addFullImagePlane(scene, images.arena, 14, 6.4);
    rope = createRope(images, pixelUnit);
    scene.add(rope);
    characters = createCharacters(scene, images, data, pixelUnit);
    createJudge(scene, images, pixelUnit);
    cheerleaders = createCheerleaders(scene, images, pixelUnit);
    createTeamBanners(scene, images, pixelUnit);
    dust = createDust(scene, images, pixelUnit);
    resize();
    built = true;
  }).catch((error) => {
    if (!disposed) {
      container.innerHTML = '<div class="scene-fallback">게임 에셋을 준비하지 못했어요. 잠시 후 다시 시도해 주세요.</div>';
      console.error(error);
    }
  });

  function animate(time) {
    if (disposed) return;
    animationId = requestAnimationFrame(animate);
    if (built) {
      currentRopeX = THREE.MathUtils.lerp(currentRopeX, targetRopeX, 0.08);
      rope.position.x = currentRopeX;
      rope.rotation.z = Math.sin(time * 0.003) * 0.008;
      characters.forEach(({ tug, cheer, baseX, baseY, side, phase }, index) => {
        const activeTug = Math.sin(time * 0.004 + phase) > -0.2;
        tug.visible = activeTug;
        cheer.visible = !activeTug;
        const bounce = Math.sin(time * 0.005 + phase) * 0.035;
        tug.position.x = baseX + side * Math.sin(time * 0.004 + index) * 0.045;
        cheer.position.x = tug.position.x;
        tug.position.y = baseY + bounce;
        cheer.position.y = baseY + bounce;
      });
      cheerleaders.forEach(({ sprite, phase }) => {
        sprite.position.y += Math.sin(time * 0.003 + phase) * 0.0009;
      });
      if (dust) {
        dust.visible = Math.sin(time * 0.004) > 0.65;
        dust.position.x = currentRopeX * 0.58;
        dust.scale.x = 0.72 + Math.sin(time * 0.006) * 0.04;
      }
    }
    renderer.render(scene, camera);
  }

  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();
  animationId = requestAnimationFrame(animate);

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(animationId);
      resizeObserver?.disconnect();
      scene.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => {
            if (material.map) material.map.dispose();
            material.dispose();
          });
        }
      });
      renderer.dispose();
    },
    update(nextData) {
      targetRopeX = ((Number(nextData.ropePosition || 50) - 50) / 50) * 2.65;
    },
  };
}
