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
const trimRectCache = new Map();
// Fallback height when a team has no active pulling sprite.
const ROPE_Y = -1.39;
const ROPE_Z = 1.34;
const ROPE_TRAVEL = 1.15;
// Height of the baked-in rope tip relative to each tug sprite's center.
// The four rows in the two supplied sheets use different grip heights.
const GRIP_Y_OFFSETS = {
  blue: [-0.44, -0.62, -0.28, -0.25],
  white: [-0.49, -0.5, -0.32, -0.28],
};
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

function alphaTrimRect(image, rect, padding = 5) {
  const key = `${image.src}:${rect.x}:${rect.y}:${rect.w}:${rect.h}:${padding}`;
  const cached = trimRectCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  const pixels = context.getImageData(0, 0, rect.w, rect.h).data;
  let minX = rect.w;
  let minY = rect.h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < rect.h; y += 1) {
    for (let x = 0; x < rect.w; x += 1) {
      if (pixels[(y * rect.w + x) * 4 + 3] > 12) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) {
    trimRectCache.set(key, rect);
    return rect;
  }

  const left = Math.max(0, minX - padding);
  const top = Math.max(0, minY - padding);
  const right = Math.min(rect.w - 1, maxX + padding);
  const bottom = Math.min(rect.h - 1, maxY + padding);
  const trimmed = {
    x: rect.x + left,
    y: rect.y + top,
    w: right - left + 1,
    h: bottom - top + 1,
  };
  trimRectCache.set(key, trimmed);
  return trimmed;
}

function cropTexture(image, rect, flipX = false) {
  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, rect.w, rect.h);
  if (flipX) {
    context.translate(rect.w, 0);
    context.scale(-1, 1);
  }
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

function addCroppedSprite(parent, image, rect, pixelUnit, scale, position, z, padding = 5, flipX = false) {
  const trimmedRect = alphaTrimRect(image, rect, padding);
  const texture = cropTexture(image, trimmedRect, flipX);
  const sprite = makeSprite(texture, trimmedRect.w * pixelUnit, trimmedRect.h * pixelUnit, scale, z);
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

function updateRopeSegment(sprite, start, end, thickness) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(0.05, Math.hypot(dx, dy));
  sprite.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, ROPE_Z);
  sprite.rotation.z = Math.atan2(dy, dx);
  // Let the drawn rope tuck under the short rope tails in each sprite.
  sprite.scale.set(length + 0.18, thickness, 1);
}

function createRope(images, pixelUnit, layout) {
  const rope = new THREE.Group();
  rope.name = 'dynamic-braided-rope';

  // Only use the uninterrupted braid. The white bindings and frayed ends in
  // the source art made the joins with the characters look like extra borders.
  const ropeRect = alphaTrimRect(images.props, { x: 160, y: 52, w: 740, h: 84 }, 1);
  const ropeTexture = cropTexture(images.props, ropeRect);
  ropeTexture.wrapS = THREE.RepeatWrapping;
  ropeTexture.repeat.x = (layout.rightAttachX - layout.leftAttachX) / 7.5;
  ropeTexture.needsUpdate = true;
  const ropeMaterial = new THREE.SpriteMaterial({
    map: ropeTexture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
  });
  const ropeSegment = new THREE.Sprite(ropeMaterial);
  ropeSegment.name = 'continuous-rope-segment';
  rope.add(ropeSegment);

  // The ribbon-only cutout avoids drawing a second rope and a bulky knot
  // across the middle of the single continuous braid.
  const marker = addCroppedSprite(
    rope,
    images.props,
    { x: 1125, y: 286, w: 120, h: 190 },
    pixelUnit,
    Math.max(0.42, 0.5 * layout.scaleFactor),
    [0, ROPE_Y - 0.31, ROPE_Z + 0.08],
    ROPE_Z + 0.08,
    2,
  );
  marker.name = 'moving-rope-ribbon';

  rope.userData.update = (shiftX, shiftY) => {
    const left = { x: layout.leftAttachX + shiftX, y: layout.gripY + shiftY };
    const right = { x: layout.rightAttachX + shiftX, y: layout.gripY + shiftY };
    const centerY = layout.gripY + shiftY;
    updateRopeSegment(ropeSegment, left, right, layout.ropeThickness);
    marker.position.x = shiftX;
    marker.position.y = centerY - 0.28;
  };

  rope.userData.update(0, 0);
  return rope;
}

function getCrowdLayout(data) {
  const activePlayers = (data.players || []).filter((player) => !player.spectator);
  const blueCount = activePlayers.filter((player) => player.team === 'blue').length;
  const whiteCount = activePlayers.filter((player) => player.team === 'white').length;
  const scaleFactor = 1 - Math.min(28, Math.max(0, activePlayers.length - 2)) * (0.6 / 28);
  const gapFor = (count) => Math.min(1.45, 5.2 / Math.max(1, count));
  const attachFor = (count) => 4.4 + Math.max(0, count - 1) * gapFor(count) / 2 - 0.7 * scaleFactor;
  return {
    characterScale: 0.86 * scaleFactor,
    scaleFactor,
    gripY: -1.54 - (1 - scaleFactor) * 0.58,
    leftAttachX: -attachFor(blueCount),
    rightAttachX: attachFor(whiteCount),
    ropeThickness: 0.27 * (0.7 + 0.3 * scaleFactor),
  };
}

function createCharacters(scene, images, data, pixelUnit, layout) {
  const characters = [];
  const sheetInfo = {
    // The supplied pull poses extend beyond their nominal grid cells so the
    // rope tail is not clipped before it reaches the dynamic center rope.
    blue: {
      image: images.blueMascots,
      columns: 5,
      rows: 4,
      tugRect: (row) => gridRect(images.blueMascots, 5, 4, 3, row, 2),
    },
    white: {
      image: images.whiteMascots,
      columns: 6,
      rows: 4,
      tugRect: (row) => gridRect(images.whiteMascots, 6, 4, 4, row, 2),
    },
  };

  for (const team of ['blue', 'white']) {
    const players = (data.players || []).filter((player) => player.team === team && !player.spectator);
    const side = team === 'blue' ? -1 : 1;
    const info = sheetInfo[team];
    const gap = Math.min(1.45, 5.2 / Math.max(players.length, 1));

    players.forEach((player, index) => {
      const offset = index - (players.length - 1) / 2;
      const row = CHARACTER_ROWS[player.characterId] ?? 0;
      const baseX = side * 4.4 - side * offset * gap;
      const baseY = layout.gripY - GRIP_Y_OFFSETS[team][row] * layout.scaleFactor;
      const tugRect = info.tugRect?.(row) || gridRect(info.image, info.columns, info.rows, info.tugColumn, row, 3);
      const tug = addCroppedSprite(scene, info.image, tugRect, pixelUnit, layout.characterScale, [baseX, baseY, 1.12], 1.12, 3, team === 'white');
      tug.name = `${team}-${player.characterId}-tug`;
      characters.push({ tug, team, baseX, baseY, footY: baseY - 1.05 * layout.scaleFactor });
    });
  }
  return characters;
}

function createJudge(scene, images, pixelUnit) {
  // The first Sejong pose reaches a little beyond the first nominal cell.
  // Give it breathing room before alpha trimming so his arms are never sliced.
  const judgeRect = { x: 48, y: 2, w: 305, h: 220 };
  const front = addCroppedSprite(scene, images.chibi, judgeRect, pixelUnit, 0.92, [0, 0.18, 1.18], 1.18);
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
    cheerleaders.push({ sprite, baseY: y, phase: index * 0.7 });
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

function createFootDust(scene, characters, scaleFactor) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  const haze = context.createRadialGradient(32, 32, 2, 32, 32, 31);
  haze.addColorStop(0, 'rgba(245, 208, 148, 0.8)');
  haze.addColorStop(0.55, 'rgba(238, 189, 119, 0.35)');
  haze.addColorStop(1, 'rgba(238, 189, 119, 0)');
  context.fillStyle = haze;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const puffs = [];
  characters.forEach(({ baseX, footY, team }) => {
    for (let index = 0; index < 2; index += 1) {
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false });
      const sprite = new THREE.Sprite(material);
      sprite.name = `${team}-foot-dust-${index}`;
      sprite.position.set(baseX + (index ? 0.42 : -0.32) * scaleFactor, footY, 1.16);
      sprite.scale.set(0.34 * scaleFactor, 0.2 * scaleFactor, 1);
      scene.add(sprite);
      puffs.push({ sprite, baseX, footY, index });
    }
  });
  return puffs;
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
  let targetRopeX = ((Number(data.ropePosition ?? 50) - 50) / 50) * ROPE_TRAVEL;
  let currentRopeX = targetRopeX;
  let rope;
  let footDust = [];
  let pullStart = -Infinity;
  let pullDirection = 0;
  let pullStrength = 0;
  let characters = [];
  let layout;
  let cheerleaders = [];
  let background;
  let built = false;

  function resize() {
    const width = Math.max(320, container.clientWidth || 800);
    const height = Math.max(260, container.clientHeight || 430);
    const viewHeight = Math.max(6.4, 14.4 * height / width);
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
    layout = getCrowdLayout(data);
    characters = createCharacters(scene, images, data, pixelUnit, layout);
    rope = createRope(images, pixelUnit, layout);
    scene.add(rope);
    createJudge(scene, images, pixelUnit);
    cheerleaders = createCheerleaders(scene, images, pixelUnit);
    createTeamBanners(scene, images, pixelUnit);
    footDust = createFootDust(scene, characters, layout.scaleFactor);
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
      const pullAge = time - pullStart;
      const pullFade = Math.max(0, 1 - pullAge / 650);
      const tugBounce = pullFade > 0
        ? pullDirection * pullStrength * Math.sin(pullAge * 0.031) * pullFade * 0.065
        : 0;
      const pullMotionX = currentRopeX + Math.sin(time * 0.004) * 0.025 + tugBounce;
      const pullMotionY = Math.sin(time * 0.005) * 0.012 + Math.abs(tugBounce) * 0.12;
      rope.userData.update(pullMotionX, pullMotionY);
      characters.forEach(({ tug, baseX, baseY }) => {
        tug.position.x = baseX + pullMotionX;
        tug.position.y = baseY + pullMotionY;
      });
      cheerleaders.forEach(({ sprite, baseY, phase }) => {
        sprite.position.y = baseY + Math.sin(time * 0.003 + phase) * 0.012;
      });
      footDust.forEach(({ sprite, baseX, footY, index }) => {
        const progress = Math.min(1, Math.max(0, pullAge / 650));
        sprite.material.opacity = pullFade * pullStrength * (index ? 0.25 : 0.35);
        sprite.position.x = baseX + pullMotionX + ((index ? 0.42 : -0.32) + (index ? 1 : -1) * progress * 0.18) * layout.scaleFactor;
        sprite.position.y = footY + progress * 0.14 * layout.scaleFactor;
        sprite.scale.set((0.34 + progress * 0.23) * layout.scaleFactor, (0.2 + progress * 0.16) * layout.scaleFactor, 1);
      });
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
      const nextTarget = ((Number(nextData.ropePosition ?? 50) - 50) / 50) * ROPE_TRAVEL;
      const delta = nextTarget - targetRopeX;
      if (Math.abs(delta) > 0.001) {
        pullDirection = Math.sign(delta);
        pullStrength = Math.min(1, Math.max(0.45, Math.abs(delta) / 0.14));
        pullStart = performance.now();
      }
      targetRopeX = nextTarget;
    },
  };
}
