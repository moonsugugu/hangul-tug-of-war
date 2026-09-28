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
const cutoutCache = new Map();
// Fallback height when a team has no active pulling sprite.
const ROPE_Y = -1.39;
const ROPE_Z = 1.34;
const ROPE_TRAVEL = 1.15;
// Pull poses overhang the nominal grid: legs drop below the row line and tails
// reach into the previous column. Row bands follow the transparent gaps in each
// sheet, and `leftReach` covers the tails.
const TUG_SHEETS = {
  blue: { columns: 5, column: 3, leftReach: 60, rowBands: [[0, 309], [309, 552], [552, 798], [798, 1086]] },
  white: { columns: 6, column: 4, leftReach: 50, rowBands: [[0, 291], [291, 561], [561, 801], [801, 1086]] },
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

// Characters in the supplied sheets spill past their grid cells and sometimes
// touch a neighbour, so a plain rectangle either clips them or picks up stray
// pieces. Keep only the alpha islands that belong to `core`: an island is kept
// unless it pokes in from the search border while living mostly outside core.
function isolateCutout(image, search, core, padding = 5) {
  const key = `${image.src}:${search.x}:${search.y}:${search.w}:${search.h}:${core.x}:${core.y}:${core.w}:${core.h}:${padding}`;
  const cached = cutoutCache.get(key);
  if (cached) return cached;

  const { w, h } = search;
  const source = document.createElement('canvas');
  source.width = w;
  source.height = h;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(image, search.x, search.y, w, h, 0, 0, w, h);
  const imageData = sourceContext.getImageData(0, 0, w, h);
  const pixels = imageData.data;
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const coreLeft = core.x - search.x;
  const coreTop = core.y - search.y;
  const coreRight = coreLeft + core.w;
  const coreBottom = coreTop + core.h;
  const kept = [false];
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let start = 0; start < w * h; start += 1) {
    if (labels[start] || pixels[start * 4 + 3] <= 12) continue;
    const label = kept.length;
    const island = [];
    let count = 0;
    let coreCount = 0;
    let touchesEdge = false;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const index = stack[--top];
      island.push(index);
      const x = index % w;
      const y = (index - x) / w;
      count += 1;
      if (x >= coreLeft && x < coreRight && y >= coreTop && y < coreBottom) coreCount += 1;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const next = ny * w + nx;
          if (labels[next] || pixels[next * 4 + 3] <= 12) continue;
          labels[next] = label;
          stack[top++] = next;
        }
      }
    }
    const keep = count >= 30 && (!touchesEdge || coreCount * 2 >= count);
    kept.push(keep);
    if (!keep) continue;
    for (const index of island) {
      const x = index % w;
      const y = (index - x) / w;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  for (let index = 0; index < w * h; index += 1) {
    if (!kept[labels[index]]) pixels[index * 4 + 3] = 0;
  }
  sourceContext.putImageData(imageData, 0, 0);

  if (maxX < 0) {
    cutoutCache.set(key, source);
    return source;
  }
  const left = Math.max(0, minX - padding);
  const topEdge = Math.max(0, minY - padding);
  const width = Math.min(w, maxX + padding + 1) - left;
  const height = Math.min(h, maxY + padding + 1) - topEdge;
  const cutout = document.createElement('canvas');
  cutout.width = width;
  cutout.height = height;
  cutout.getContext('2d').drawImage(source, left, topEdge, width, height, 0, 0, width, height);
  cutoutCache.set(key, cutout);
  return cutout;
}

function canvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
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
  return canvasTexture(canvas);
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

function mirrored(canvas) {
  const flipped = document.createElement('canvas');
  flipped.width = canvas.width;
  flipped.height = canvas.height;
  const context = flipped.getContext('2d');
  context.translate(canvas.width, 0);
  context.scale(-1, 1);
  context.drawImage(canvas, 0, 0);
  return flipped;
}

// The baked-in rope tail is what reaches the right edge of a pull pose, so the
// top-most opaque run in the right-most column marks the grip height.
function ropeTipY(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const pixels = context.getImageData(0, 0, width, height).data;
  for (let x = width - 1; x >= 0; x -= 1) {
    let start = -1;
    for (let y = 0; y < height; y += 1) {
      const opaque = pixels[(y * width + x) * 4 + 3] > 12;
      if (opaque && start < 0) start = y;
      if (!opaque && start >= 0) return (start + y - 1) / 2;
    }
    if (start >= 0) return (start + height - 1) / 2;
  }
  return height / 2;
}

// Top of the head (ears included) and the horizontal centre of the top slice,
// so a name tag hangs over the face rather than the sprite's bounding box.
const headAnchorCache = new WeakMap();

function headAnchor(canvas) {
  const cached = headAnchorCache.get(canvas);
  if (cached) return cached;
  const { width, height } = canvas;
  const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  let top = -1;
  let sumX = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    if (top >= 0 && y > top + height * 0.22) break;
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] <= 12) continue;
      if (top < 0) top = y;
      sumX += x;
      count += 1;
    }
  }
  const anchor = count ? { x: sumX / count, y: top } : { x: width / 2, y: 0 };
  headAnchorCache.set(canvas, anchor);
  return anchor;
}

function tugRects(image, sheet, row) {
  const cellWidth = image.naturalWidth / sheet.columns;
  const [top, bottom] = sheet.rowBands[row];
  const left = Math.round(sheet.column * cellWidth);
  // The rope tail runs into the next pose, so the right edge stays on the grid
  // line; the drawn rope covers that cut.
  const right = Math.round((sheet.column + 1) * cellWidth) - 2;
  return {
    search: { x: left - sheet.leftReach, y: top, w: right - left + sheet.leftReach, h: bottom - top },
    core: { x: left, y: top, w: right - left, h: bottom - top },
  };
}

// Each pull pose has its own short rope drawn in front of its hands. Next to the
// shared scene rope those tails read as extra rope pieces, so erase the tail
// from the right edge back to where the fist makes the run noticeably thicker.
const ropelessCache = new WeakMap();

function trimRopeTail(canvas, ropeY) {
  const cached = ropelessCache.get(canvas);
  if (cached) return cached;
  const { width, height } = canvas;
  const trimmed = document.createElement('canvas');
  trimmed.width = width;
  trimmed.height = height;
  const context = trimmed.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const opaque = (x, y) => y >= 0 && y < height && pixels[(y * width + x) * 4 + 3] > 12;
  const center = Math.round(ropeY);
  const runAt = (x) => {
    let start = -1;
    for (let offset = 0; offset <= 6 && start < 0; offset += 1) {
      if (opaque(x, center + offset)) start = center + offset;
      else if (opaque(x, center - offset)) start = center - offset;
    }
    if (start < 0) return null;
    let top = start;
    let bottom = start;
    while (opaque(x, top - 1)) top -= 1;
    while (opaque(x, bottom + 1)) bottom += 1;
    return [top, bottom];
  };

  let x = width - 1;
  while (x > 0 && !runAt(x)) x -= 1;
  let ropeThickness = 0;
  for (let probe = x; probe > x - 6 && probe >= 0; probe -= 1) {
    const run = runAt(probe);
    if (run) ropeThickness = Math.max(ropeThickness, run[1] - run[0] + 1);
  }
  const limit = Math.round(width * 0.55);
  for (; x >= limit; x -= 1) {
    const run = runAt(x);
    if (!run || run[1] - run[0] + 1 > ropeThickness * 1.6 + 2) break;
    for (let y = run[0] - 1; y <= run[1] + 1; y += 1) {
      if (y >= 0 && y < height) pixels[(y * width + x) * 4 + 3] = 0;
    }
  }
  context.putImageData(imageData, 0, 0);
  ropelessCache.set(canvas, trimmed);
  return trimmed;
}

function addCanvasSprite(parent, canvas, pixelUnit, scale, position, z, flipX = false) {
  const cutout = flipX ? mirrored(canvas) : canvas;
  const sprite = makeSprite(canvasTexture(cutout), cutout.width * pixelUnit, cutout.height * pixelUnit, scale, z);
  sprite.position.set(...position);
  parent?.add(sprite);
  return sprite;
}

function addIsolatedSprite(parent, image, search, core, pixelUnit, scale, position, z, flipX = false) {
  const isolated = isolateCutout(image, search, core);
  const cutout = flipX ? mirrored(isolated) : isolated;
  const sprite = makeSprite(canvasTexture(cutout), cutout.width * pixelUnit, cutout.height * pixelUnit, scale, z);
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

// resize() never shows less than ±7.2 world units horizontally, and the whole
// crowd slides up to ROPE_TRAVEL with the rope, so a team line ending inside
// this limit stays on screen at every aspect ratio and rope position.
const TUG_OUTER_LIMIT = 7.15 - ROPE_TRAVEL;
// Keeps the innermost puller clear of the judge in the middle.
const TUG_INNER_LIMIT = 1.1;
const CROWDED_TEAM_SIZE = 4;

// Distances from the centre line, innermost puller first.
function teamSlots(count, halfWidth) {
  if (!count) return [];
  const outer = TUG_OUTER_LIMIT - halfWidth;
  const inner = TUG_INNER_LIMIT + halfWidth;
  const gap = count > 1 ? Math.min(1.45, (outer - inner) / (count - 1)) : 0;
  const spread = (count - 1) * gap;
  const center = Math.max(inner + spread / 2, Math.min(4.4, outer - spread / 2));
  return Array.from({ length: count }, (_, index) => center - spread / 2 + index * gap);
}

function getCrowdLayout(data, images, pixelUnit) {
  const activePlayers = (data.players || []).filter((player) => !player.spectator);
  const blueCount = activePlayers.filter((player) => player.team === 'blue').length;
  const whiteCount = activePlayers.filter((player) => player.team === 'white').length;
  const scaleFactor = 1 - Math.min(28, Math.max(0, activePlayers.length - 2)) * (0.6 / 28);
  const characterScale = 0.86 * scaleFactor;
  const halfWidthFor = (image, sheet) => (image.naturalWidth / sheet.columns + sheet.leftReach + 10) / 2 * pixelUnit * characterScale;
  const slots = {
    blue: teamSlots(blueCount, halfWidthFor(images.blueMascots, TUG_SHEETS.blue)),
    white: teamSlots(whiteCount, halfWidthFor(images.whiteMascots, TUG_SHEETS.white)),
  };
  const attachFor = (teamSlotsList) => (teamSlotsList.at(-1) ?? 4.4) - 0.7 * scaleFactor;
  return {
    characterScale,
    scaleFactor,
    slots,
    gripY: -1.54 - (1 - scaleFactor) * 0.58,
    leftAttachX: -attachFor(slots.blue),
    rightAttachX: attachFor(slots.white),
    ropeThickness: 0.27 * (0.4 + 0.6 * scaleFactor),
  };
}

function createCharacters(scene, images, data, pixelUnit, layout) {
  const characters = [];
  const sheetImages = { blue: images.blueMascots, white: images.whiteMascots };
  const unit = pixelUnit * layout.characterScale;

  for (const team of ['blue', 'white']) {
    const players = (data.players || []).filter((player) => player.team === team && !player.spectator);
    const side = team === 'blue' ? -1 : 1;
    const image = sheetImages[team];

    players.forEach((player, index) => {
      const row = CHARACTER_ROWS[player.characterId] ?? 0;
      const { search, core } = tugRects(image, TUG_SHEETS[team], row);
      const isolated = isolateCutout(image, search, core);
      const ropeY = ropeTipY(isolated);
      const cutout = trimRopeTail(isolated, ropeY);
      // The row guides are deliberately generous because the supplied sheets
      // have different transparent margins. Clamp the actual trimmed sprite,
      // not just the guide-cell estimate, so a wide hat/ear/tail can never be
      // cut by the arena edge on a narrow viewport.
      const halfSpriteWidth = cutout.width * unit / 2;
      const safeSlot = Math.min(layout.slots[team][index], TUG_OUTER_LIMIT - halfSpriteWidth);
      const baseX = side * Math.max(TUG_INNER_LIMIT + halfSpriteWidth, safeSlot);
      // A crowded team staggers into a near and a far lane so faces peek out
      // between neighbours. The one shared rope is drawn over every puller, and
      // the height offset stays inside its thickness so all hands stay on it.
      const lane = players.length >= CROWDED_TEAM_SIZE ? (index % 2 === 0 ? 1 : -1) : 0;
      const laneOffsetY = -lane * Math.min(0.06 * cutout.height * unit, layout.ropeThickness * 0.35);
      const z = 1.12 + lane * 0.02;
      const baseY = layout.gripY - (cutout.height / 2 - ropeY) * unit + laneOffsetY;
      const tug = addCanvasSprite(scene, cutout, pixelUnit, layout.characterScale, [baseX, baseY, z], z, team === 'white');
      tug.name = `${team}-${player.characterId}-tug`;
      const head = headAnchor(cutout);
      const headOffsetX = (head.x - cutout.width / 2) * unit * (team === 'white' ? -1 : 1);
      characters.push({
        tug,
        team,
        lane,
        baseX,
        baseY,
        footY: baseY - (cutout.height / 2 - 12) * unit,
        playerId: player.id,
        name: player.name,
        headOffsetX,
        headOffsetY: (cutout.height / 2 - head.y) * unit,
      });
    });
  }
  return characters;
}

function createJudge(scene, images, pixelUnit) {
  // The first Sejong pose runs from the hat (y≈4) to the shoes (y≈328), and the
  // next row's hair starts right below him, so isolate him instead of slicing.
  const front = addIsolatedSprite(
    scene,
    images.chibi,
    { x: 40, y: 0, w: 320, h: 346 },
    { x: 64, y: 0, w: 280, h: 300 },
    pixelUnit,
    0.8,
    [0, -0.12, 1.18],
    1.18,
  );
  front.name = 'sejong-judge-sprite';
  return front;
}

// Rows in the cheerleader sheet are separated by transparent gaps near these
// y values, not by the 362px grid, so feet and drums overhang the grid rows.
const CHEER_ROW_BANDS = [[0, 400], [400, 740], [740, 1086]];

function cheerRects(image, column, row) {
  const cellWidth = image.naturalWidth / 6;
  const [top, bottom] = CHEER_ROW_BANDS[row];
  const core = { x: Math.round(column * cellWidth), y: top, w: Math.round(cellWidth), h: bottom - top };
  const left = Math.max(0, core.x - 24);
  const right = Math.min(image.naturalWidth, core.x + core.w + 24);
  return { search: { x: left, y: top, w: right - left, h: bottom - top }, core };
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
    const { search, core } = cheerRects(images.cheerleaders, column, index % 2);
    const sprite = addIsolatedSprite(scene, images.cheerleaders, search, core, pixelUnit, scale, [x, y, 0.25], 0.25);
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

const NAME_TAG_MAX_TIERS = 4;
const NAME_TAG_GAP_PX = 4;

function createNameTags(container, characters, selfId) {
  const layer = document.createElement('div');
  layer.className = 'name-layer';
  layer.setAttribute('aria-hidden', 'true');
  for (const character of characters) {
    const tag = document.createElement('div');
    tag.className = `name-tag name-tag--${character.team}`;
    const pill = document.createElement('span');
    pill.className = 'name-tag__pill';
    if (character.playerId === selfId) {
      tag.classList.add('is-self');
      const me = document.createElement('b');
      me.textContent = '나';
      pill.append(me);
    }
    const name = document.createElement('span');
    name.className = 'name-tag__name';
    name.textContent = character.name;
    pill.append(name);
    const representative = document.createElement('b');
    representative.className = 'name-tag__representative';
    representative.textContent = '대표';
    representative.hidden = true;
    pill.append(representative);
    const line = document.createElement('i');
    line.className = 'name-tag__line';
    tag.append(pill, line);
    layer.append(tag);
    character.nameTag = { el: tag, line, representative, dy: 0, flashSeen: 0, flashing: false };
  }
  container.append(layer);
  return layer;
}

// Greedy interval tiering: the viewer's own tag claims tier 0 first, then the
// rest take the lowest tier where they do not overlap. When a team needs more
// than NAME_TAG_MAX_TIERS, other tags shrink, and then only the viewer's own
// tag stays (others reappear while they flash after scoring).
function assignTiers(members, anchorsX) {
  const tiers = [];
  const placed = new Map();
  const order = [...members.keys()].sort((a, b) => {
    const priority = (member) => member.nameTag.el.classList.contains('is-representative') ? 0 : member.nameTag.el.classList.contains('is-self') ? 1 : 2;
    const selfA = priority(members[a]);
    const selfB = priority(members[b]);
    return (selfA - selfB) || (anchorsX[a] - anchorsX[b]);
  });
  for (const index of order) {
    const tag = members[index].nameTag;
    if (tag.el.classList.contains('is-idle')) continue;
    const half = tag.el.offsetWidth / 2 + NAME_TAG_GAP_PX / 2;
    const left = anchorsX[index] - half;
    const right = anchorsX[index] + half;
    let tier = 0;
    while (tiers[tier]?.some(([start, end]) => left < end && right > start)) tier += 1;
    (tiers[tier] ??= []).push([left, right]);
    placed.set(index, tier);
  }
  return { placed, tierCount: tiers.length };
}

function layoutNameTags(characters, camera, pxPerUnit) {
  for (const team of ['blue', 'white']) {
    const members = characters.filter((character) => character.team === team);
    if (!members.length) continue;
    const anchorsX = members.map((character) => (character.baseX + character.headOffsetX - camera.left) * pxPerUnit);
    const anchorsY = members.map((character) => (camera.top - character.baseY - character.headOffsetY) * pxPerUnit);
    const crowded = members.some((character) => character.lane !== 0);
    let result;
    for (const density of ['full', 'compact', 'selfOnly']) {
      for (const { nameTag } of members) {
        const isImportant = nameTag.el.classList.contains('is-self') || nameTag.el.classList.contains('is-representative');
        nameTag.el.classList.toggle('is-compact', density !== 'full' && !isImportant);
        nameTag.el.classList.toggle('is-idle', density === 'selfOnly' && !isImportant);
      }
      result = assignTiers(members, anchorsX);
      if (result.tierCount <= NAME_TAG_MAX_TIERS) break;
    }
    // In a crowded line every tag rises above the highest head so none of them
    // sits on top of a back-lane face; thin leader lines point to each head.
    const baseline = crowded ? Math.min(...anchorsY) : null;
    members.forEach((character, index) => {
      const tag = character.nameTag;
      const height = tag.el.offsetHeight || 18;
      const tier = result.placed.get(index) ?? 0;
      const bottom = (baseline ?? anchorsY[index]) - NAME_TAG_GAP_PX - tier * (height + 3);
      tag.dy = bottom - anchorsY[index];
      tag.line.style.height = `${Math.max(0, -tag.dy)}px`;
      tag.line.hidden = -tag.dy < 10;
    });
  }
}

function updateNameTags(characters, camera, pxPerUnit, flashUntil) {
  const now = Date.now();
  for (const character of characters) {
    const tag = character.nameTag;
    if (!tag) continue;
    const x = (character.tug.position.x + character.headOffsetX - camera.left) * pxPerUnit;
    const y = (camera.top - character.tug.position.y - character.headOffsetY) * pxPerUnit + tag.dy;
    tag.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    const until = flashUntil?.get(character.playerId) || 0;
    const flashing = until > now;
    if (flashing && until > tag.flashSeen) {
      // Restart the animation when the same player scores again mid-flash.
      tag.el.classList.remove('is-flash');
      void tag.el.offsetWidth;
      tag.el.classList.add('is-flash');
      tag.flashSeen = until;
    } else if (!flashing && tag.flashing) {
      tag.el.classList.remove('is-flash');
    }
    tag.flashing = flashing;
  }
}

export function mountTugScene(container, data, { selfId, flashUntil } = {}) {
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
  let nameLayer;
  let pxPerUnit = 1;
  let currentData = data;
  let representativeKey = '';

  function updateRepresentatives(nextData) {
    const relay = nextData.phase === 'round' && nextData.mode?.id === 'relay' ? nextData.relay : null;
    const nextKey = `${relay?.blueId || ''}|${relay?.whiteId || ''}`;
    if (nextKey === representativeKey) return;
    representativeKey = nextKey;
    for (const character of characters) {
      const isRepresentative = character.playerId === relay?.[`${character.team}Id`];
      character.nameTag.el.classList.toggle('is-representative', isRepresentative);
      character.nameTag.representative.hidden = !isRepresentative;
    }
    if (nameLayer) layoutNameTags(characters, camera, pxPerUnit);
  }

  function resize() {
    const width = Math.max(320, container.clientWidth || 800);
    const height = Math.max(260, container.clientHeight || 430);
    const viewHeight = Math.max(6.4, 14.4 * height / width);
    // Keep the complete 14.4-unit stage visible even when the browser is
    // portrait-shaped. Without this floor the outer pullers were rendered
    // outside the camera and looked sliced in half.
    const viewWidth = Math.max(14.4, viewHeight * (width / height));
    camera.left = -viewWidth / 2;
    camera.right = viewWidth / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    if (background?.userData.resize) background.userData.resize(viewWidth, viewHeight);
    pxPerUnit = (container.clientWidth || width) / viewWidth;
    if (nameLayer) layoutNameTags(characters, camera, pxPerUnit);
  }

  loaded.then((images) => {
    if (disposed) return;
    const pixelUnit = 13.8 / 1448;
    background = addFullImagePlane(scene, images.arena, 14, 6.4);
    layout = getCrowdLayout(data, images, pixelUnit);
    characters = createCharacters(scene, images, data, pixelUnit, layout);
    rope = createRope(images, pixelUnit, layout);
    scene.add(rope);
    createJudge(scene, images, pixelUnit);
    cheerleaders = createCheerleaders(scene, images, pixelUnit);
    createTeamBanners(scene, images, pixelUnit);
    footDust = createFootDust(scene, characters, layout.scaleFactor);
    nameLayer = createNameTags(container, characters, selfId);
    resize();
    updateRepresentatives(currentData);
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
      updateNameTags(characters, camera, pxPerUnit, flashUntil);
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
      nameLayer?.remove();
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
      currentData = nextData;
      if (built) updateRepresentatives(nextData);
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
