import { canSend, encodeMessage, stateDelta, takeMessageToken } from './transport.mjs';
import { BUSY_MESSAGE, createLoadGuard } from './load-guard.mjs';

// 과부하 보호(coderule 규칙 19): 서버가 바쁘면 점수·명단 방송을 늦추고, 끊지 않고, 매우 바쁠 때만 새 방을 막는다.
const loadGuard = createLoadGuard();
import { WORD_PROMPTS, WORD_QUIZ_PROMPTS, HANGUL_CREATION_QUIZ_PROMPTS } from './quiz-prompts.js';
import { MAX_CSV_BYTES, validateCustomQuestions } from '../shared/question-csv.js';
import { SCORE_MULTIPLIER_LEVELS, SCORE_SETTING_PHASES, ANSWER_REVIEW_MS } from '../shared/score-settings.js';
import { HOST_PARTICIPATION_OPTIONS } from '../shared/teacher-participation.js';
import { getAiLevel, getAiAnswerDelay } from '../shared/ai-levels.js';
import { createServer } from 'node:http';
import { existsSync, createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { REPAIR_PROMPTS } from './spacing-prompts.js';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const STATIC_ROOT = existsSync(DIST) ? DIST : ROOT;
const PORT = Number(process.env.PORT || 8787);
// 서버 나누기: 같은 서버를 여러 개(포트만 다르게) 띄우고 방을 나눠 맡긴다. 노드는 메인 스레드 하나라 한 서버는 약 30~35개 반이 한계다.
// SHARD_COUNT 가 없으면 지금처럼 서버 하나로 돈다. 방 코드 첫 글자 = 서버 번호(서버 1·2·3 → 2·3·4).
const SHARD_COUNT = Math.min(8, Math.max(1, Math.floor(Number(process.env.SHARD_COUNT) || 1)));
const SHARD_ID = Math.min(SHARD_COUNT, Math.max(1, Math.floor(Number(process.env.SHARD_ID) || 1)));
const SHARD_PREFIX = '23456789';
const WS_PATH = /^\/ws(?:\/s[1-8])?$/;
const SHARD_HEALTH_PATH = /^\/ws\/s[1-8]\/health$/;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const REFERENCE_CPM = 120;
const RELAY_LIMIT_MS = 12_000;
const QUIZ_WRONG_PENALTY = 30;
const RELAY_DUEL_PAUSE_MS = Number(process.env.RELAY_DUEL_PAUSE_MS ?? 1_800);
const ROUND_MULTIPLIERS = [1, 1.1, 1.3, 1.5, 1.5];
const ROUND_DURATION_MS = Number(process.env.ROUND_DURATION_MS || 180_000);
const ROUND_INTRO_MS = Number(process.env.ROUND_INTRO_MS ?? 15_000);
const OVERTIME_MS = Number(process.env.OVERTIME_MS || 10_000);
const MAX_RELAY_OVERTIMES = 2;
const INTERMISSION_MS = Number(process.env.INTERMISSION_MS ?? 15_000);
const WHEEL_DURATION_MS = Number(process.env.WHEEL_DURATION_MS || 7_000);
const PLACEMENT_MS = Number(process.env.PLACEMENT_MS || 30_000);
const TEAM_REVEAL_MS = Number(process.env.TEAM_REVEAL_MS || 7_000);
const ROPE_MAX_STEPS = 20;
const ROPE_POINTS_PER_STEP = 75;
const MAX_PLAYERS_PER_ROOM = 30;
const MAX_ROOMS = Math.max(1, Math.min(2000, Math.floor(Number(process.env.MAX_ROOMS) || 400)));
const CHARACTER_IDS = ['rabbit', 'bear', 'cat', 'chick', 'panda', 'sheep', 'fox', 'penguin'];

function shuffledIndexes(length, avoidFirst) {
  const order = Array.from({ length }, (_, index) => index);
  for (let index = length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  if (length > 1 && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

function shuffledWordIndexes(length, avoidFirst) {
  const groups = new Map();
  for (let index = 0; index < length; index += 1) {
    const category = WORD_PROMPTS[index]?.category || '기타';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(index);
  }

  const categories = [...groups.keys()];
  const categoryOrder = shuffledIndexes(categories.length, -1).map((index) => categories[index]);
  const order = [];
  while (order.length < length) {
    for (const category of categoryOrder) {
      const group = groups.get(category);
      if (!group?.length) continue;
      const pick = Math.floor(Math.random() * group.length);
      order.push(group.splice(pick, 1)[0]);
    }
  }

  if (length > 1 && order[0] === avoidFirst) [order[0], order[1]] = [order[1], order[0]];
  return order;
}

// Each player walks a private shuffled deck that is reshuffled every lap, so
// rounds and players do not all see the same fixed sequence.
function deckIndex(progress, key, length, position, makeOrder = shuffledIndexes) {
  progress.decks ??= {};
  const lap = Math.floor(position / length);
  let deck = progress.decks[key];
  if (!deck || deck.lap !== lap) {
    deck = { lap, order: makeOrder(length, deck?.order[length - 1]) };
    progress.decks[key] = deck;
  }
  return deck.order[position % length];
}

function currentWordPrompt(progress, key = 'word') {
  const index = deckIndex(progress, key, WORD_PROMPTS.length, progress.promptIndex, shuffledWordIndexes);
  return { id: `word-${progress.promptIndex}-${index}`, prompt: WORD_PROMPTS[index] };
}

function currentPracticePrompt(progress) {
  const { id, prompt } = currentWordPrompt(progress, 'practice');
  return { id: `practice-${id}`, prompt };
}

// Alternate native-word definitions with documented Hangul/Sejong questions.
function currentQuizPrompt(progress, pool) {
  const position = progress.promptIndex;
  let id;
  let prompt;
  if (pool) {
    const index = deckIndex(progress, 'tabletQuiz', pool.length, position);
    id = `quiz-${position}-tablet-${index}`;
    prompt = pool[index];
  } else if (position % 2 === 1) {
    const index = deckIndex(progress, 'hangul', HANGUL_CREATION_QUIZ_PROMPTS.length, Math.floor(position / 2));
    id = `quiz-${position}-hangul-${index}`;
    prompt = HANGUL_CREATION_QUIZ_PROMPTS[index];
  } else {
    const index = deckIndex(progress, 'wordQuiz', WORD_QUIZ_PROMPTS.length, Math.floor(position / 2));
    id = `quiz-${position}-word-${index}`;
    prompt = WORD_QUIZ_PROMPTS[index];
  }

  // Keep each question's randomized choices stable across frequent state broadcasts,
  // and avoid putting the answer in the same position twice in a row.
  if (progress.quizChoicePromptId !== id) {
    const choices = [...prompt.choices];
    for (let index = choices.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [choices[index], choices[swap]] = [choices[swap], choices[index]];
    }
    let answerIndex = choices.indexOf(prompt.answer);
    if (choices.length > 1 && answerIndex === progress.lastQuizAnswerIndex) {
      const swapIndex = (answerIndex + 1 + Math.floor(Math.random() * (choices.length - 1))) % choices.length;
      [choices[answerIndex], choices[swapIndex]] = [choices[swapIndex], choices[answerIndex]];
      answerIndex = swapIndex;
    }
    progress.quizChoicePromptId = id;
    progress.quizChoices = choices;
    progress.lastQuizAnswerIndex = answerIndex;
  }
  return { id, prompt: { ...prompt, choices: progress.quizChoices } };
}

function currentRepairPrompt(progress) {
  const index = deckIndex(progress, 'repair', REPAIR_PROMPTS.length, progress.promptIndex);
  return { id: `repair-${progress.promptIndex}-${index}`, prompt: REPAIR_PROMPTS[index] };
}

function currentPlacementPrompt(progress) {
  const index = deckIndex(progress, 'placement', PLACEMENT_PROMPTS.length, progress.promptIndex);
  return { id: `placement-${progress.promptIndex}-${index}`, sentence: PLACEMENT_PROMPTS[index] };
}

// Korean typing speed is counted in keystrokes (타): a syllable costs one key
// for the initial consonant, one or two for the vowel, and zero to two for the
// final consonant, depending on whether they are compound jamo.
const COMPOUND_VOWELS = new Set([9, 10, 11, 14, 15, 16, 19]);
const COMPOUND_FINALS = new Set([3, 5, 6, 9, 10, 11, 12, 13, 14, 15, 18]);

function keystrokesFor(char) {
  const code = char.codePointAt(0) - 0xac00;
  if (code < 0 || code > 11171) return 1;
  const vowel = Math.floor(code / 28) % 21;
  const final = code % 28;
  return 1 + (COMPOUND_VOWELS.has(vowel) ? 2 : 1) + (final === 0 ? 0 : COMPOUND_FINALS.has(final) ? 2 : 1);
}

function correctKeystrokes(input, expected) {
  const typed = [...normalizeSentence(input)];
  const target = [...expected];
  let total = 0;
  target.forEach((char, index) => {
    if (typed[index] === char) total += keystrokesFor(char);
  });
  return total;
}

// Strongest typists pick first; each one joins the weaker team that still has
// room, so team sizes differ by at most one and total speed stays close.
function assignTeamsBySkill(players, hostTeam) {
  const maxSize = Math.ceil(players.length / 2);
  const teams = { blue: { size: 0, total: 0 }, white: { size: 0, total: 0 } };
  const host = hostTeam ? players.find((player) => player.isHost) : null;
  if (host) {
    host.team = hostTeam;
    teams[hostTeam].size = 1;
    teams[hostTeam].total = host.typingSpeed;
  }
  const ranked = players.filter((player) => player !== host).map((player, order) => ({ player, order }))
    .sort((a, b) => (b.player.typingSpeed - a.player.typingSpeed) || (a.order - b.order));
  for (const { player } of ranked) {
    const open = ['blue', 'white'].filter((team) => teams[team].size < maxSize);
    const team = open.sort((a, b) => (teams[a].total - teams[b].total) || (teams[a].size - teams[b].size))[0];
    player.team = team;
    teams[team].size += 1;
    teams[team].total += player.typingSpeed;
  }
}

const RELAY_PROMPTS = [
  '우리말을 아끼고 한글을 소중히 지켜요.',
  '한글날에는 우리말의 아름다움을 함께 느껴요.',
  '세종대왕님, 누구나 읽고 쓰는 세상을 열어 주셔서 감사합니다.',
  '정확한 말과 따뜻한 마음으로 서로를 존중해요.',
  '세종대왕은 백성이 쉽게 읽고 쓰도록 훈민정음을 만들었습니다.',
  '훈민정음은 1446년에 세상에 반포되었습니다.',
  '한글의 자음과 모음에는 소리를 생각한 원리가 담겨 있습니다.',
  '오늘도 바른 우리말로 서로의 마음을 따뜻하게 전해요.',
];

const PLACEMENT_PROMPTS = [
  '한글은 세종대왕이 만든 글자입니다.',
  '우리말을 바르고 고운 말로 써요.',
  '가을 하늘이 맑고 높습니다.',
  '친구와 함께 줄다리기를 해요.',
  '훈민정음은 백성을 위한 글자예요.',
  '책을 읽으면 생각이 쑥쑥 자라요.',
  '바람이 살랑살랑 불어옵니다.',
  '우리 반 모두 힘을 모아요.',
  '또박또박 정확하게 입력해요.',
  '한글날에는 우리말을 더 아껴요.',
  '햇살이 운동장을 따뜻하게 비춰요.',
  '서로 도우면 무엇이든 할 수 있어요.',
];

const MODES = [
  { id: 'word', name: '말모이 기본전', description: '더 다양해진 순우리말을 빠르고 정확하게 입력해요.', duration: ROUND_DURATION_MS },
  { id: 'quiz', name: '뜻풀이 객관식 역전전', description: '네 가지 보기로 순우리말과 한글 역사를 풀어요. 기본 오답은 30점 감점, 설정한 점수 배율을 곱해요!', duration: ROUND_DURATION_MS },
  { id: 'repair', name: '바른말 수리공', description: '띄어쓰기를 제대로 해서 바른 문장을 완성해요.', duration: ROUND_DURATION_MS },
  { id: 'relay', name: '훈민정음 랜덤 릴레이', description: '기본 대표 정답은 줄 2칸, 친구들의 정답은 1점! 설정한 점수 배율을 곱해요.', duration: ROUND_DURATION_MS },
];

const TABLET_MODES = [
  { id: 'quiz', pool: 'words', name: '순우리말 뜻풀이', description: '뜻을 읽고 알맞은 순우리말을 터치해요.', duration: ROUND_DURATION_MS },
  { id: 'quiz', pool: 'principles', name: '한글 창제 원리', description: '자음과 모음에 담긴 원리를 보기 네 개로 풀어요.', duration: ROUND_DURATION_MS },
  { id: 'quiz', pool: 'sejong', name: '세종대왕 이야기', description: '세종대왕과 훈민정음 이야기를 터치로 풀어요.', duration: ROUND_DURATION_MS },
  { id: 'quiz', name: '말모이 종합 퀴즈', description: '순우리말과 한글 이야기를 함께 풀어요. 빠른 정답은 보너스, 기본 오답 감점은 30점이에요.', duration: ROUND_DURATION_MS },
];
const TABLET_QUIZ_POOLS = {
  words: WORD_QUIZ_PROMPTS,
  principles: HANGUL_CREATION_QUIZ_PROMPTS.filter((prompt) => prompt.category === '한글 창제 원리'),
  sejong: HANGUL_CREATION_QUIZ_PROMPTS.filter((prompt) => prompt.category === '세종대왕 이야기'),
};

function getModes(room) {
  if (room.customModes) return room.customModes;
  return room.playMode === 'tablet' ? TABLET_MODES : MODES;
}

function currentRoomQuizPrompt(room, player) {
  const pool = room.customQuestions?.questions || TABLET_QUIZ_POOLS[getMode(room)?.pool];
  const { id, prompt } = currentQuizPrompt(player.progress, pool);
  return { id: room.customQuestions ? `set-${room.questionRevision}-round-${room.game.roundIndex}-${id}` : room.playMode === 'tablet' ? `round-${room.game.roundIndex}-${id}` : id, prompt };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
};

const rooms = new Map();
const socketRooms = new Map();

function createGame() {
  return {
    phase: 'lobby',
    roundIndex: -1,
    modeIndex: -1,
    mode: null,
    roundStartedAt: 0,
    roundEndsAt: 0,
    roundIntroUntil: 0,
    intermissionUntil: 0,
    wheelEndsAt: 0,
    wheelSelectedIndex: null,
    overtimeCount: 0,
    scores: { blue: 0, white: 0 },
    rawScores: { blue: 0, white: 0 },
    roundScores: [],
    rosterCounts: { blue: 0, white: 0 },
    relay: null,
    relayUsed: { blue: new Set(), white: new Set() },
    winner: null,
    notice: '',
  };
}

function createRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let roomId = '';
  do {
    roomId = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
    // 서버가 여러 개면 첫 글자를 서버 번호로 바꿔, 학생 화면이 코드만 보고 같은 서버로 찾아가게 한다.
    if (SHARD_COUNT > 1) roomId = SHARD_PREFIX[SHARD_ID - 1] + roomId.slice(1);
  } while (rooms.has(roomId));
  return roomId;
}

function createRoom(playMode = 'typing', hostParticipation = 'auto') {
  const room = {
    id: createRoomId(),
    playMode,
    hostParticipation,
    sessionMode: 'class',
    aiLevel: 1,
    scoreMultiplier: 1,
    customQuestions: null,
    customModes: null,
    questionRevision: 0,
    game: createGame(),
    players: new Map(),
    playerTokens: new Map(),
    emptySince: null,
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

function normalizeRoomId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

// networkInterfaces() 는 Windows 에서 1회 수십 ms 가 걸린다. 상태를 보낼 때마다(플레이어 수 × 0.5초마다)
// 부르면 30명 방에서 서버가 밀려 입장이 15명 안팎에서 멈췄다. 1분 동안 결과를 기억해 둔다.
let lanAddressCache = { value: '', at: 0 };
function getLanAddress() {
  if (lanAddressCache.value && Date.now() - lanAddressCache.at < 60_000) return lanAddressCache.value;
  let found = '127.0.0.1';
  for (const entries of Object.values(networkInterfaces())) {
    const address = entries?.find((entry) => !entry.internal && (entry.family === 'IPv4' || entry.family === 4));
    if (address?.address) { found = address.address; break; }
  }
  lanAddressCache = { value: found, at: Date.now() };
  return found;
}

function getRoomUrl(roomId) {
  const baseUrl = PUBLIC_BASE_URL || `http://${getLanAddress()}:${PORT}`;
  return `${baseUrl}/?room=${encodeURIComponent(roomId)}`;
}

function getRoomBySocket(ws) {
  const roomId = socketRooms.get(ws);
  return roomId ? rooms.get(roomId) : null;
}

function getPlayerBySocket(ws) {
  const room = getRoomBySocket(ws);
  return room?.players.get(ws.playerId) || null;
}

function getRoomForPlayer(player) {
  return player ? rooms.get(player.roomId) : null;
}

function getActivePlayers(room) {
  return [...room.players.values()].filter((player) => !player.spectator);
}

function getAvailablePlayers(room) {
  return getActivePlayers(room).filter((player) => player.isAI || player.ws?.readyState === 1);
}

function getHostTeam(room) {
  if (room.sessionMode !== 'class') return 'blue';
  return ['blue', 'white'].includes(room.hostParticipation) ? room.hostParticipation : null;
}

function applyHostParticipation(room, player) {
  if (!player.isHost) return;
  player.spectator = room.sessionMode === 'class' && room.hostParticipation === 'observe';
  player.team = player.spectator ? null : getHostTeam(room) || player.team || (getCounts(room).blue <= getCounts(room).white ? 'blue' : 'white');
  player.progress = player.spectator ? null : player.progress || { promptIndex: 0, promptStartedAt: Date.now() };
  player.roundDraft = null;
}

function getCounts(room) {
  const game = room.game;
  if (game.phase !== 'lobby' && game.rosterCounts.blue + game.rosterCounts.white > 0) {
    return { ...game.rosterCounts };
  }

  return getActivePlayers(room).reduce((counts, player) => {
    if (player.team === 'blue' || player.team === 'white') counts[player.team] += 1;
    return counts;
  }, { blue: 0, white: 0 });
}

function getMultipliers(room) {
  const counts = getCounts(room);
  const target = Math.max(counts.blue, counts.white, 1);
  return {
    blue: counts.blue ? target / counts.blue : 1,
    white: counts.white ? target / counts.white : 1,
  };
}

function sanitizeName(name) {
  return String(name || '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
}

function sanitizeCharacter(characterId) {
  return CHARACTER_IDS.includes(characterId) ? characterId : 'bear';
}

function normalizeWord(value) {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeSentence(value) {
  return String(value || '').normalize('NFKC').replace(/\r/g, '').trim();
}

function getMode(room) {
  const game = room.game;
  return getModes(room)[game.modeIndex] || null;
}

function getPromptFor(room, player) {
  const game = room.game;
  if (!player || player.spectator) return null;
  if (game.phase === 'lobby' && player?.progress) {
    if (room.playMode === 'tablet') return null;
    const { id, prompt } = currentPracticePrompt(player.progress);
    return {
      kind: 'practice',
      id,
      word: prompt.word,
      category: prompt.category,
      meaning: prompt.meaning,
      example: prompt.example,
    };
  }
  if (game.phase === 'placement' && player?.progress) {
    const { id, sentence } = currentPlacementPrompt(player.progress);
    return { kind: 'placement', id, sentence };
  }
  if (game.phase !== 'round' || !player || player.spectator) return null;
  const mode = getMode(room);
  if (!mode) return null;

  if (mode.id === 'word') {
    const { id, prompt } = currentWordPrompt(player.progress);
    return { kind: 'word', id, word: prompt.word, category: prompt.category, length: [...prompt.word].length };
  }

  if (mode.id === 'quiz') {
    const { id, prompt } = currentRoomQuizPrompt(room, player);
    return { kind: 'quiz', id, source: room.customQuestions ? 'custom' : 'default', category: prompt.category, meaning: prompt.meaning, choices: prompt.choices };
  }

  if (mode.id === 'repair') {
    const { id, prompt } = currentRepairPrompt(player.progress);
    return { kind: 'repair', id, question: prompt.question };
  }

  if (mode.id === 'relay' && game.relay) {
    const isSelected = game.relay.blueId === player.id || game.relay.whiteId === player.id;
    return {
      kind: 'relay',
      selected: isSelected,
      submitted: Boolean(game.relay.submissions[player.id]),
      selectedTeam: game.relay.blueId === player.id ? 'blue' : game.relay.whiteId === player.id ? 'white' : null,
      prompt: game.relay.prompt,
      relayDeadline: game.relay.deadline,
    };
  }

  return null;
}

function publicSelf(player) {
  return player ? {
    id: player.id,
    name: player.name,
    team: player.team,
    characterId: player.characterId,
    isHost: player.isHost,
    spectator: player.spectator,
    // Typing results stay private to each player; others only see teams.
    practiceCount: player.practiceCount || 0,
    placementKeystrokes: player.placementKeystrokes || 0,
    typingSpeed: player.typingSpeed ?? null,
  } : null;
}

function publicStateFor(room, player, common) {
  if (common) return { ...common, self: publicSelf(player), prompt: getPromptFor(room, player) };
  const game = room.game;
  const counts = getCounts(room);
  const multipliers = getMultipliers(room);
  const difference = game.scores.blue - game.scores.white;
  // One visible step is roughly one accurate answer. Either team can pull the
  // center marker through all twenty steps, even if the other team has no score.
  const ropeStep = Math.max(-ROPE_MAX_STEPS, Math.min(ROPE_MAX_STEPS, -Math.round(difference / ROPE_POINTS_PER_STEP)));
  const ropePosition = 50 + ropeStep * (43 / ROPE_MAX_STEPS);
  const mode = getMode(room);

  return {
    type: 'state',
    roomId: room.id,
    playMode: room.playMode,
    sessionMode: room.sessionMode,
    aiLevel: room.aiLevel,
    hostParticipation: room.hostParticipation,
    scoreMultiplier: room.scoreMultiplier,
    roundModes: getModes(room),
    questionSet: { fileName: room.customQuestions?.fileName || '', count: room.customQuestions?.questions.length || 0, revision: room.questionRevision },
    roomUrl: getRoomUrl(room.id),
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    phase: game.phase,
    roundIndex: game.roundIndex,
    roundNumber: game.roundIndex + 1,
    // The fifth slot is always part of the match plan. It becomes active only
    // when rounds 1–4 finish 2:2 and the wheel selects a rematch mode.
    totalRounds: MODES.length + 1,
    mode: mode ? { ...mode } : null,
    timeRemainingMs: game.phase === 'round' ? Math.max(0, game.roundEndsAt - Date.now()) : 0,
    roundIntroRemainingMs: game.phase === 'roundIntro' ? Math.max(0, game.roundIntroUntil - Date.now()) : 0,
    roundIntroDurationMs: ROUND_INTRO_MS,
    intermissionRemainingMs: game.phase === 'intermission' ? Math.max(0, game.intermissionUntil - Date.now()) : 0,
    intermissionDurationMs: INTERMISSION_MS,
    wheelRemainingMs: game.phase === 'wheel' ? Math.max(0, game.wheelEndsAt - Date.now()) : 0,
    placementRemainingMs: game.phase === 'placement' ? Math.max(0, game.placementEndsAt - Date.now()) : 0,
    placementDurationMs: PLACEMENT_MS,
    teamRevealRemainingMs: game.phase === 'teamReveal' ? Math.max(0, game.teamRevealUntil - Date.now()) : 0,
    wheelDurationMs: WHEEL_DURATION_MS,
    wheelSelectedIndex: game.wheelSelectedIndex,
    overtimeCount: game.overtimeCount,
    scores: game.scores,
    rawScores: game.rawScores,
    roundScores: game.roundScores,
    roundWins: {
      blue: game.roundScores.filter((round) => round.winner === 'blue').length,
      white: game.roundScores.filter((round) => round.winner === 'white').length,
    },
    counts,
    multipliers,
    ropePosition,
    ropeStep,
    ropeMaxSteps: ROPE_MAX_STEPS,
    winner: game.winner,
    notice: game.notice,
    self: publicSelf(player),
    players: [...room.players.values()].map((entry) => ({
      id: entry.id,
      name: entry.name,
      team: entry.team,
      characterId: entry.characterId,
      isHost: entry.isHost,
      spectator: entry.spectator,
      isAI: Boolean(entry.isAI),
      connected: Boolean(entry.isAI || entry.ws?.readyState === 1),
      scoreCount: entry.scoreCount || 0,
    })),
    prompt: getPromptFor(room, player),
    relay: game.relay ? {
      blueId: game.relay.blueId,
      whiteId: game.relay.whiteId,
      prompt: game.relay.prompt,
      deadline: game.relay.deadline,
      blueSubmitted: Boolean(game.relay.submissions[game.relay.blueId]),
      whiteSubmitted: Boolean(game.relay.submissions[game.relay.whiteId]),
      lastResult: game.relay.lastResult || null,
    } : null,
  };
}

function send(ws, payload, serialized) {
  if (canSend(ws)) ws.send(serialized ? encodeMessage(payload, serialized) : JSON.stringify(payload));
}

function sendPlayerState(room, player, common, serialized) {
  if (!canSend(player.ws)) return;
  const state = publicStateFor(room, player, common);
  const message = player.ws.supportsDelta ? stateDelta(player.ws, state, serialized) : state;
  if (message) send(player.ws, message, serialized);
}

function broadcastPhase(room) {
  const game = room.game;
  return `${game.phase}:${game.roundIndex}:${game.relay?.deadline}:${Boolean(game.relay?.lastResult)}`;
}

function flushBroadcast(room) {
  clearTimeout(room.broadcastTimer);
  room.broadcastTimer = null;
  if (rooms.get(room.id) !== room) return;
  const common = publicStateFor(room, null);
  const serialized = new Map();
  for (const player of room.players.values()) sendPlayerState(room, player, common, serialized);
  room.lastBroadcastAt = Date.now();
  room.lastBroadcastPhase = broadcastPhase(room);
}

function broadcast(room) {
  if (!room || !rooms.has(room.id) || room.emptySince !== null) return;
  // 화면 단계와 릴레이 결과는 즉시 보존하고 점수·명단 갱신만 묶습니다.
  if (room.lastBroadcastPhase !== broadcastPhase(room)) return flushBroadcast(room);
  if (!room.broadcastTimer) room.broadcastTimer = setTimeout(() => flushBroadcast(room), loadGuard.interval(60));
}

function setNotice(room, text) {
  const game = room.game;
  game.notice = text;
  setTimeout(() => {
    if (rooms.get(room.id) === room && game.notice === text) {
      game.notice = '';
      broadcast(room);
    }
  }, 3_000);
}

function checkRopeWin(room) {
  if (room.sessionMode === 'waiting') return;
  // Relay keeps rotating representatives until its round timer expires.
  if (room.game.mode === 'relay') return;
  const ropeStep = Math.max(-ROPE_MAX_STEPS, Math.min(ROPE_MAX_STEPS, -Math.round((room.game.scores.blue - room.game.scores.white) / ROPE_POINTS_PER_STEP)));
  if (Math.abs(ropeStep) === ROPE_MAX_STEPS) finishRound(room, 'rope');
}

function addTeamScore(room, team, score, checkWin = true) {
  const game = room.game;
  const multiplier = getMultipliers(room)[team];
  const weighted = Math.max(0, score) * ROUND_MULTIPLIERS[game.roundIndex] * room.scoreMultiplier;
  game.rawScores[team] += weighted;
  game.scores[team] += weighted * multiplier;

  if (checkWin) checkRopeWin(room);
}

function subtractTeamScore(room, team, points) {
  const game = room.game;
  const penalty = Math.max(0, points) * room.scoreMultiplier;
  if (!penalty) return;
  game.rawScores[team] -= penalty / getMultipliers(room)[team];
  game.scores[team] -= penalty;
  checkRopeWin(room);
}

function addRelayScore(room, team, score) {
  const points = Math.max(0, score) * room.scoreMultiplier;
  if (!points) return;
  const game = room.game;
  // Base relay points are 150 for a representative and one for a supporter;
  // apply the room setting when awarded, without reweighting earlier answers.
  game.rawScores[team] += points / getMultipliers(room)[team];
  game.scores[team] += points;
}

// Clients flash a player's name tag whenever this counter goes up.
function creditPlayer(player, score) {
  if (player && score > 0) player.scoreCount = (player.scoreCount || 0) + 1;
}

function calculateTypedScore(input, expected, elapsedMs, mode = 'word') {
  const typed = [...String(input || '')];
  const target = [...expected];
  const comparedLength = Math.max(typed.length, target.length);
  let correctChars = 0;
  for (let index = 0; index < comparedLength; index += 1) {
    if (typed[index] && typed[index] === target[index]) correctChars += 1;
  }

  const accuracy = comparedLength ? correctChars / comparedLength : 0;
  const seconds = Math.max(0.75, elapsedMs / 1000);
  const cpm = correctChars / seconds * 60;
  const speed = Math.min(1, cpm / (mode === 'repair' ? 150 : REFERENCE_CPM));
  const exact = normalizeSentence(input) === normalizeSentence(expected);

  return {
    exact,
    accuracy,
    cpm,
    score: accuracy * 60 + speed * 40,
    correctChars,
  };
}

function resetPlayerProgress(room) {
  const now = Date.now();
  for (const player of getActivePlayers(room)) {
    player.progress = { promptIndex: 0, promptStartedAt: now };
    player.roundDraft = null;
  }
}

function queueRound(room, index) {
  const game = room.game;
  const modeIndex = index === MODES.length ? game.wheelSelectedIndex : index;
  const mode = getModes(room)[modeIndex];
  if (!mode) return;
  game.phase = 'roundIntro';
  game.roundIndex = index;
  game.modeIndex = modeIndex;
  game.mode = mode.id;
  game.roundIntroUntil = Date.now() + ROUND_INTRO_MS;
  game.scores = { blue: 0, white: 0 };
  game.rawScores = { blue: 0, white: 0 };
  game.relay = null;
  game.notice = `${index === MODES.length ? '결승' : `${index + 1}라운드`} · ${mode.name} 규칙을 확인하세요!`;
  if (ROUND_INTRO_MS <= 0) beginRound(room, index);
  else broadcast(room);
}

function beginRound(room, index) {
  const game = room.game;
  const modeIndex = index === MODES.length ? game.wheelSelectedIndex : index;
  const mode = getModes(room)[modeIndex];
  if (!mode) return;

  game.phase = 'round';
  game.roundIndex = index;
  game.modeIndex = modeIndex;
  game.mode = mode.id;
  game.roundStartedAt = Date.now();
  game.roundEndsAt = game.roundStartedAt + mode.duration;
  game.overtimeCount = 0;
  game.scores = { blue: 0, white: 0 };
  game.rawScores = { blue: 0, white: 0 };
  game.notice = `${index === MODES.length ? '결승' : `${index + 1}라운드`} · ${mode.name}`;
  game.relay = null;
  game.relayUsed = { blue: new Set(), white: new Set() };
  resetPlayerProgress(room);

  if (mode.id === 'relay') startRelayDuel(room);
  else scheduleAiAnswer(room);
  broadcast(room);
}

function finishRound(room, reason = 'time') {
  const game = room.game;
  if (game.phase !== 'round') return;
  if (reason === 'time') settleRoundDrafts(room);
  const bluePoints = Math.round(game.scores.blue);
  const whitePoints = Math.round(game.scores.white);
  if (room.sessionMode === 'waiting') {
    game.roundScores.push({ round: game.roundIndex + 1, mode: getMode(room)?.name, blue: bluePoints, white: 0, winner: 'blue', reason: 'practice' });
    game.relay = null;
    game.phase = 'intermission';
    game.intermissionUntil = Date.now() + INTERMISSION_MS;
    game.notice = '연습을 마쳤어요. 다음 종목을 읽어 보고 이어서 연습하세요.';
    broadcast(room);
    return;
  }
  const relayTiebreak = bluePoints === whitePoints && game.mode === 'relay' && game.overtimeCount >= MAX_RELAY_OVERTIMES;
  if (bluePoints === whitePoints && !relayTiebreak) {
    game.overtimeCount += 1;
    game.roundEndsAt = Date.now() + OVERTIME_MS;
    game.notice = `동점! ${Math.round(OVERTIME_MS / 1000)}초 연장전이 시작됩니다.`;
    if (game.mode === 'relay') startRelayDuel(room);
    broadcast(room);
    return;
  }
  const winner = relayTiebreak ? (Math.random() < 0.5 ? 'blue' : 'white') : bluePoints > whitePoints ? 'blue' : 'white';
  const roundScore = {
    round: game.roundIndex + 1,
    mode: getMode(room)?.name || '',
    blue: bluePoints,
    white: whitePoints,
    winner,
    reason: relayTiebreak ? 'tiebreak' : reason,
    overtimeCount: game.overtimeCount,
  };
  game.roundScores.push(roundScore);
  game.relay = null;

  if (game.roundIndex === MODES.length) {
    endGame(room, winner);
    return;
  }

  if (game.roundIndex === MODES.length - 1) {
    const blueWins = game.roundScores.filter((round) => round.winner === 'blue').length;
    const whiteWins = game.roundScores.filter((round) => round.winner === 'white').length;
    if (blueWins !== whiteWins) {
      endGame(room, blueWins > whiteWins ? 'blue' : 'white');
      return;
    }
    game.phase = 'wheel';
    game.wheelSelectedIndex = Math.floor(Math.random() * MODES.length);
    game.wheelEndsAt = Date.now() + WHEEL_DURATION_MS;
    game.notice = '2:2 동점! 돌림판으로 결승 종목을 정합니다.';
    broadcast(room);
    return;
  }

  game.phase = 'intermission';
  game.intermissionUntil = Date.now() + INTERMISSION_MS;
  game.notice = relayTiebreak
    ? `연장 2회 후에도 동점이라 추첨으로 ${winner === 'blue' ? '청팀' : '백팀'}이 승리했어요. 다음 라운드를 준비하세요.`
    : `${game.roundIndex + 1}라운드 ${winner === 'blue' ? '청팀' : '백팀'} 승리! 다음 라운드를 준비하세요.`;
  broadcast(room);
}

function endGame(room, winner) {
  const game = room.game;
  if (game.phase === 'results') return;
  game.phase = 'results';
  game.winner = winner;
  game.roundEndsAt = 0;
  game.relay = null;
  game.notice = `${winner === 'blue' ? '청팀' : '백팀'} 최종 승리!`;
  broadcast(room);
}

function startRelayDuel(room) {
  const game = room.game;
  if (game.phase !== 'round' || game.mode !== 'relay' || Date.now() >= game.roundEndsAt) return;
  const byTeam = {
    blue: getAvailablePlayers(room).filter((player) => player.team === 'blue'),
    white: getAvailablePlayers(room).filter((player) => player.team === 'white'),
  };
  if (!byTeam.blue.length || (!byTeam.white.length && room.sessionMode !== 'waiting')) return;
  for (const player of getActivePlayers(room)) player.roundDraft = null;

  const selected = {};
  for (const team of ['blue', 'white']) {
    if (!byTeam[team].length) { selected[team] = null; continue; }
    let available = byTeam[team].filter((player) => !game.relayUsed[team].has(player.id));
    if (!available.length) {
      game.relayUsed[team].clear();
      available = byTeam[team];
    }
    const player = available[Math.floor(Math.random() * available.length)];
    game.relayUsed[team].add(player.id);
    selected[team] = player.id;
  }

  const prompt = RELAY_PROMPTS[Math.floor(Math.random() * RELAY_PROMPTS.length)];
  game.relay = {
    blueId: selected.blue,
    whiteId: selected.white,
    prompt,
    startedAt: Date.now(),
    deadline: Date.now() + RELAY_LIMIT_MS,
    submissions: {},
    lastResult: null,
  };
  scheduleAiAnswer(room);
  broadcast(room);
}

function scheduleAiAnswer(room) {
  if (room.sessionMode !== 'ai' || room.game.phase !== 'round') return;
  const bot = getActivePlayers(room).find((entry) => entry.isAI);
  const prompt = getPromptFor(room, bot);
  if (!bot || !prompt || prompt.submitted) return;
  const startedAt = prompt.kind === 'relay' ? room.game.relay.startedAt : bot.progress.promptStartedAt;
  bot.nextAnswerAt = startedAt + getAiAnswerDelay(room.aiLevel, prompt);
}

function answerAsAi(room, now) {
  const bot = getActivePlayers(room).find((entry) => entry.isAI);
  if (!bot || !bot.nextAnswerAt || now < bot.nextAnswerAt) return;
  bot.nextAnswerAt = 0;
  const prompt = getPromptFor(room, bot);
  if (!prompt || prompt.submitted || (prompt.kind === 'relay' && room.game.relay.lastResult)) return;
  const correct = Math.random() < getAiLevel(room.aiLevel).accuracy;
  if (prompt.kind === 'quiz') {
    const source = currentRoomQuizPrompt(room, bot).prompt;
    const wrong = source.choices.filter((choice) => choice !== source.answer);
    handleChoice(bot, correct ? source.answer : wrong[Math.floor(Math.random() * wrong.length)], prompt.id);
  } else {
    const expected = prompt.kind === 'word' ? prompt.word : prompt.kind === 'repair' ? currentRepairPrompt(bot.progress).prompt.answer : prompt.prompt;
    const answer = correct ? expected : `${expected.slice(0, -1)}?`;
    if (prompt.kind === 'relay') handleRelayAnswer(bot, answer, prompt.relayDeadline);
    else handleTypedAnswer(bot, answer);
  }
  if (room.game.phase === 'round' && getMode(room)?.id !== 'relay') scheduleAiAnswer(room);
}

function finishRelayDuel(room) {
  const game = room.game;
  const relay = game.relay;
  if (game.phase !== 'round' || !relay || relay.lastResult) return;
  settleRelayDrafts(room, relay);
  checkRopeWin(room);
  if (game.phase !== 'round') return;

  const blueScore = Object.values(relay.submissions).filter((entry) => entry.team === 'blue').reduce((sum, entry) => sum + entry.score, 0);
  const whiteScore = Object.values(relay.submissions).filter((entry) => entry.team === 'white').reduce((sum, entry) => sum + entry.score, 0);

  const winner = blueScore === whiteScore ? 'draw' : blueScore > whiteScore ? 'blue' : 'white';
  relay.lastResult = { winner, blueScore, whiteScore };
  broadcast(room);

  setTimeout(() => {
    if (rooms.get(room.id) === room && room.game === game && game.phase === 'round' && game.mode === 'relay' && game.relay === relay) startRelayDuel(room);
  }, RELAY_DUEL_PAUSE_MS);
}

function awardTimeoutScore(room, player, score) {
  if (score <= 0) return;
  creditPlayer(player, score);
  addTeamScore(room, player.team, score, false);
  send(player.ws, { type: 'timeoutScore', score, scoreMultiplier: room.scoreMultiplier });
}

function settleRelayDrafts(room, relay) {
  for (const player of getActivePlayers(room)) {
    const draft = player.roundDraft;
    player.roundDraft = null;
    if (!draft || draft.kind !== 'relay' || draft.deadline !== relay.deadline || relay.submissions[player.id] || !normalizeSentence(draft.text)) continue;
    const result = calculateTypedScore(draft.text, relay.prompt, Date.now() - relay.startedAt, 'repair');
    const representative = player.id === relay.blueId || player.id === relay.whiteId;
    const maxScore = representative ? ROPE_POINTS_PER_STEP * 2 : 1;
    const score = result.exact ? maxScore : result.score / 100 * maxScore;
    relay.submissions[player.id] = { team: player.team, exact: result.exact, score: score * room.scoreMultiplier };
    if (score > 0) {
      creditPlayer(player, score);
      addRelayScore(room, player.team, score);
      send(player.ws, { type: 'timeoutScore', score, scoreMultiplier: room.scoreMultiplier, relay: true, representative });
    }
  }
}

function settleRoundDrafts(room) {
  const mode = getMode(room)?.id;
  if (mode === 'relay') {
    if (room.game.relay && !room.game.relay.lastResult) settleRelayDrafts(room, room.game.relay);
    return;
  }
  if (!['word', 'repair'].includes(mode)) return;
  for (const player of getActivePlayers(room)) {
    const draft = player.roundDraft;
    player.roundDraft = null;
    const prompt = getPromptFor(room, player);
    if (!draft || draft.kind !== mode || draft.promptId !== prompt?.id || !normalizeSentence(draft.text)) continue;
    const expected = mode === 'word'
      ? currentWordPrompt(player.progress).prompt.word
      : currentRepairPrompt(player.progress).prompt.answer;
    const result = calculateTypedScore(draft.text, expected, Date.now() - player.progress.promptStartedAt, mode);
    awardTimeoutScore(room, player, result.score);
    player.progress.promptIndex += 1;
    player.progress.promptStartedAt = Date.now();
  }
}

function handlePlacementAnswer(room, player, answer) {
  const game = room.game;
  if (!player.progress) return;
  if (Date.now() >= game.placementEndsAt) return finishPlacement(room);
  const { sentence } = currentPlacementPrompt(player.progress);
  const keystrokes = correctKeystrokes(answer, sentence);
  player.placementKeystrokes = (player.placementKeystrokes || 0) + keystrokes;
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();
  send(player.ws, {
    type: 'placementResult',
    correct: normalizeSentence(answer) === sentence,
    keystrokes,
    totalKeystrokes: player.placementKeystrokes,
  });
  broadcast(room);
}

function finishPlacement(room) {
  const game = room.game;
  if (game.phase !== 'placement') return;
  const minutes = PLACEMENT_MS / 60_000;
  const players = getActivePlayers(room);
  for (const player of players) {
    player.typingSpeed = Math.round((player.placementKeystrokes || 0) / minutes);
  }
  assignTeamsBySkill(players, getHostTeam(room));
  game.rosterCounts = getActivePlayers(room).reduce((counts, player) => {
    counts[player.team] += 1;
    return counts;
  }, { blue: 0, white: 0 });
  // Team assignment is automatic, so do not hold the class on a separate
  // reveal screen. The first round begins as soon as the 30-second test ends.
  game.notice = '타자 실력이 비슷하도록 팀을 나눴어요! 1라운드를 시작합니다.';
  queueRound(room, 0);
}

function handlePracticeAnswer(room, player, answer) {
  const game = room.game;
  if (game.phase !== 'lobby' || !player.progress || !normalizeSentence(answer)) return;
  const { prompt } = currentPracticePrompt(player.progress);
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const result = calculateTypedScore(answer, prompt.word, elapsedMs, 'word');
  player.practiceCount = (player.practiceCount || 0) + 1;
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();
  send(player.ws, {
    type: 'practiceResult',
    correct: result.exact,
    word: prompt.word,
    meaning: prompt.meaning,
    example: prompt.example,
    category: prompt.category,
    keystrokes: result.correctChars,
    cpm: result.cpm,
    practiceCount: player.practiceCount,
  });
  broadcast(room);
}

function handleTypedAnswer(player, answer) {
  const room = getRoomForPlayer(player);
  if (!room || player.spectator) return;
  if (room.playMode === 'tablet') return;
  const game = room.game;
  if (game.phase === 'lobby') return handlePracticeAnswer(room, player, answer);
  if (game.phase === 'placement') return handlePlacementAnswer(room, player, answer);
  if (game.phase !== 'round' || !player.progress || !getMode(room)) return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  if (Date.now() < player.progress.promptStartedAt) return;
  const mode = getMode(room);
  if (!['word', 'repair'].includes(mode.id)) return;

  const source = mode.id === 'word'
    ? currentWordPrompt(player.progress).prompt
    : currentRepairPrompt(player.progress).prompt;
  const expected = mode.id === 'word' ? source.word : source.answer;
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const result = calculateTypedScore(answer, expected, elapsedMs, mode.id);
  player.roundDraft = null;
  creditPlayer(player, result.score);
  addTeamScore(room, player.team, result.score);
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now() + (result.exact ? 0 : ANSWER_REVIEW_MS);

  send(player.ws, {
    type: 'answerResult',
    correct: result.exact,
    score: result.score,
    scoreMultiplier: room.scoreMultiplier,
    submittedAnswer: String(answer),
    question: mode.id === 'word' ? source.word : source.question,
    accuracy: result.accuracy,
    cpm: result.cpm,
    word: mode.id === 'word' ? source.word : undefined,
    meaning: mode.id === 'word' ? source.meaning : undefined,
    example: mode.id === 'word' ? source.example : undefined,
    category: mode.id === 'word' ? source.category : undefined,
    correctAnswer: expected,
    explanation: mode.id === 'repair' ? source.explanation : source.meaning,
  });
  broadcast(room);
}

function handleChoice(player, choice, promptId) {
  const room = getRoomForPlayer(player);
  if (!room || player.spectator || !player.progress || !player.team) return;
  const game = room.game;
  if (game.phase !== 'round' || getMode(room)?.id !== 'quiz') return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  if (Date.now() < player.progress.promptStartedAt) return;
  const { id, prompt } = currentRoomQuizPrompt(room, player);
  // Tablet clients identify the question so a double tap cannot answer the next one.
  if ((room.playMode === 'tablet' || room.customQuestions || promptId != null) && promptId !== id) return;
  if (!prompt.choices.includes(choice)) return;
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const correct = choice === prompt.answer;
  const speedBonus = Math.max(0, 40 * (1 - Math.min(elapsedMs, 8_000) / 8_000));
  const score = correct ? 60 + speedBonus : -QUIZ_WRONG_PENALTY;

  if (correct) {
    creditPlayer(player, score);
    addTeamScore(room, player.team, score);
  } else {
    subtractTeamScore(room, player.team, QUIZ_WRONG_PENALTY);
  }
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now() + (correct ? 0 : ANSWER_REVIEW_MS);
  send(player.ws, {
    type: 'choiceResult',
    correct,
    score,
    scoreMultiplier: room.scoreMultiplier,
    submittedAnswer: choice,
    question: prompt.meaning,
    answer: prompt.answer,
    meaning: prompt.meaning,
    category: prompt.category,
    explanation: prompt.explanation || `${prompt.answer}: ${prompt.meaning}`,
  });
  broadcast(room);
}

function handleRelayAnswer(player, answer, deadline) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  const relay = game.relay;
  if (game.phase !== 'round' || game.mode !== 'relay' || !relay) return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  if (Date.now() >= relay.deadline) return finishRelayDuel(room);
  if (deadline !== relay.deadline) return;
  const team = relay.blueId === player.id ? 'blue' : relay.whiteId === player.id ? 'white' : null;
  if (!player.team || player.spectator || relay.submissions[player.id] || relay.lastResult) return;

  const exact = normalizeSentence(answer) === normalizeSentence(relay.prompt);
  const representative = Boolean(team);
  const score = exact ? representative ? ROPE_POINTS_PER_STEP * 2 : 1 : 0;
  player.roundDraft = null;
  relay.submissions[player.id] = { team: player.team, exact, score: score * room.scoreMultiplier };
  send(player.ws, { type: 'relayAnswerResult', correct: exact, score, scoreMultiplier: room.scoreMultiplier, representative,
    submittedAnswer: String(answer), question: relay.prompt, answer: relay.prompt, explanation: '띄어쓰기와 글자를 확인하고 제시된 문장을 똑같이 입력해 주세요.' });
  if (score) {
    creditPlayer(player, score);
    addRelayScore(room, player.team, score);
  }
  if (game.phase !== 'round') return;
  if (getAvailablePlayers(room).every((entry) => relay.submissions[entry.id])) finishRelayDuel(room);
  else broadcast(room);
}

function handleDraft(player, message) {
  const room = getRoomForPlayer(player);
  if (!room || player.spectator || !player.progress || typeof message.text !== 'string') return;
  const game = room.game;
  if (game.phase !== 'round') return;
  if (Date.now() >= game.roundEndsAt) return finishRound(room);
  const mode = getMode(room)?.id;
  const text = message.text.slice(0, 500);
  if (mode === 'relay') {
    const relay = game.relay;
    if (!relay || relay.lastResult || relay.submissions[player.id]) return;
    if (Date.now() >= relay.deadline) return finishRelayDuel(room);
    if (message.deadline !== relay.deadline) return;
    player.roundDraft = { kind: 'relay', deadline: relay.deadline, text };
    return;
  }
  if (!['word', 'repair'].includes(mode)) return;
  if (Date.now() < player.progress.promptStartedAt) return;
  const prompt = getPromptFor(room, player);
  if (message.promptId !== prompt?.id) return;
  player.roundDraft = { kind: mode, promptId: prompt.id, text };
}

function startGame(player) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const game = room.game;
  if (!player.isHost) return;
  if (room.sessionMode === 'waiting') {
    const classCount = [...room.players.values()].filter((entry) => !entry.isAI && entry.ws?.readyState === 1 && (!entry.isHost || room.hostParticipation !== 'observe')).length;
    if (classCount < 2) return send(player.ws, { type: 'error', message: '본 경기에 참가할 사람이 두 명 이상 모여야 해요. 학생 입장을 조금 더 기다려 주세요.' });
    resetRoomToLobby(room);
  } else if (game.phase !== 'lobby') return;
  if (getAvailablePlayers(room).length < 2) {
    send(player.ws, { type: 'error', message: '경기에 참가하는 사람이 두 명 이상 있어야 시작할 수 있어요. 진행만 하는 선생님은 참가 인원에서 제외해요.' });
    return;
  }

  // Teams are decided by a short typing test before round 1.
  const now = Date.now();
  room.game = createGame();
  room.game.phase = 'placement';
  room.game.placementEndsAt = now + PLACEMENT_MS;
  room.game.notice = '타자 실력을 재고 있어요. 문장을 정확하게 입력해 주세요!';
  for (const entry of room.players.values()) {
    entry.spectator = entry.isHost && room.hostParticipation === 'observe';
    entry.progress = entry.spectator ? null : { promptIndex: 0, promptStartedAt: now };
    if (entry.spectator) entry.team = null;
    entry.placementKeystrokes = 0;
    entry.typingSpeed = null;
    entry.scoreCount = 0;
  }
  if (room.playMode === 'tablet') {
    const players = getActivePlayers(room);
    const hostTeam = getHostTeam(room);
    const fixedHost = hostTeam ? players.find((entry) => entry.isHost) : null;
    const remaining = players.filter((entry) => entry !== fixedHost);
    const counts = { blue: 0, white: 0 };
    if (fixedHost) { fixedHost.team = hostTeam; counts[hostTeam] = 1; }
    const order = shuffledIndexes(remaining.length);
    order.forEach((playerIndex) => {
      const team = counts.blue <= counts.white ? 'blue' : 'white';
      remaining[playerIndex].team = team;
      counts[team] += 1;
    });
    room.game.phase = 'teamReveal';
    room.game.teamRevealUntil = now + TEAM_REVEAL_MS;
    room.game.rosterCounts = getCounts(room);
    room.game.notice = '태블릿 객관식 모드! 인원수가 비슷하도록 팀을 무작위로 나눴어요.';
  }
  broadcast(room);
}

function resetRoomToLobby(room) {
  room.sessionMode = 'class';
  for (const entry of room.players.values()) if (entry.isAI) room.players.delete(entry.id);
  room.game = createGame();
  for (const entry of room.players.values()) {
    entry.spectator = false;
    entry.team = null;
    entry.progress = { promptIndex: 0, promptStartedAt: Date.now() };
    entry.practiceCount = 0;
    entry.scoreCount = 0;
    entry.roundDraft = null;
    applyHostParticipation(room, entry);
    if (!entry.spectator && !entry.team) entry.team = getCounts(room).blue <= getCounts(room).white ? 'blue' : 'white';
  }
}

function resetToLobby(player) {
  const room = getRoomForPlayer(player);
  if (!room || !player.isHost) return;
  resetRoomToLobby(room);
  broadcast(room);
}

function startSoloMode(player, message) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const fail = (text) => send(player.ws, { type: 'error', message: text });
  if (!player.isHost) return fail('선생님(방장)만 모드를 시작할 수 있어요.');
  if (!(room.game.phase === 'lobby' || (room.sessionMode === 'ai' && room.game.phase === 'results'))) return;
  const ai = message.type === 'startAI';
  if (ai && [...room.players.values()].filter((entry) => !entry.isAI).length !== 1) return fail('AI 1:1 모드는 방에 혼자 있을 때 시작해 주세요.');
  if (ai && !getAiLevel(message.level)) return fail('AI 난이도는 1단계부터 10단계까지 선택해 주세요.');
  resetRoomToLobby(room);
  room.sessionMode = ai ? 'ai' : 'waiting';
  if (ai) room.aiLevel = message.level;
  for (const entry of room.players.values()) {
    entry.spectator = !entry.isHost;
    entry.team = entry.isHost ? 'blue' : null;
    entry.progress = entry.isHost ? { promptIndex: 0, promptStartedAt: Date.now() } : null;
  }
  if (ai) {
    const bot = { id: randomUUID(), roomId: room.id, ws: null, name: `AI ${room.aiLevel}단계`, team: 'white', characterId: 'fox', isAI: true, isHost: false, spectator: false, progress: { promptIndex: 0, promptStartedAt: Date.now() }, scoreCount: 0 };
    room.players.set(bot.id, bot);
  }
  room.game.rosterCounts = { blue: 1, white: ai ? 1 : 0 };
  queueRound(room, 0);
}

function selectWaitingRound(player, message) {
  const room = getRoomForPlayer(player);
  if (!room || !player.isHost || room.sessionMode !== 'waiting') return;
  if (!Number.isInteger(message.roundIndex) || message.roundIndex < 0 || message.roundIndex >= MODES.length) return;
  // Starting a new practice cycle keeps the room's wait history bounded.
  room.game.roundScores = [];
  beginRound(room, message.roundIndex);
}

function joinPlayer(ws, message) {
  if (getPlayerBySocket(ws)) {
    send(ws, { type: 'error', message: '이미 방에 들어와 있어요.' });
    return;
  }

  const roomId = normalizeRoomId(message.roomId);
  const room = rooms.get(roomId);
  if (!room) {
    send(ws, { type: 'error', message: '방을 찾을 수 없어요. 방 코드가 맞는지 확인해 주세요.' });
    return;
  }

  const game = room.game;
  if (room.sessionMode === 'ai' || game.phase === 'results') {
    send(ws, { type: 'error', message: room.sessionMode === 'ai' ? 'AI 1:1 경기 중인 방이에요. 학급 대기실로 돌아온 뒤 입장해 주세요.' : '경기가 끝났어요. 선생님이 대기실로 돌아온 뒤 입장해 주세요.' });
    return;
  }
  if ([...room.players.values()].filter((entry) => !entry.isHost && !entry.isAI).length >= MAX_PLAYERS_PER_ROOM) {
    send(ws, { type: 'error', message: '이 방은 최대 30명까지 참여할 수 있어요.' });
    return;
  }

  const name = sanitizeName(message.name);
  if (!name) {
    send(ws, { type: 'error', message: '닉네임을 한 글자 이상 입력해 주세요.' });
    return;
  }

  const counts = getCounts(room);
  const team = counts.blue <= counts.white ? 'blue' : 'white';
  const player = {
    id: randomUUID(),
    token: randomUUID() + randomUUID(),
    roomId,
    ws,
    name,
    team: room.sessionMode === 'waiting' ? null : team,
    characterId: sanitizeCharacter(message.characterId),
    isHost: room.players.size === 0,
    spectator: room.sessionMode === 'waiting',
    progress: room.sessionMode === 'waiting' ? null : { promptIndex: 0, promptStartedAt: Date.now() },
    practiceCount: 0,
  };
  room.players.set(player.id, player);
  applyHostParticipation(room, player);
  room.playerTokens.set(player.token, player.id);
  if (!player.spectator && game.phase !== 'lobby' && game.rosterCounts.blue + game.rosterCounts.white > 0) game.rosterCounts[player.team] += 1;
  attachPlayer(room, player, ws);
  broadcast(room);
}

// 토큰은 해당 참가자의 joined 응답에만 포함합니다. 공개 상태·QR에는 넣지 않습니다.
function attachPlayer(room, player, ws, resumed = false) {
  const oldSocket = player.ws;
  if (oldSocket && oldSocket !== ws) {
    socketRooms.delete(oldSocket);
    oldSocket.close(1000, '다른 화면에서 다시 접속했어요.');
  }
  player.ws = ws;
  player.disconnectedAt = null;
  room.emptySince = null;
  socketRooms.set(ws, room.id);
  ws.playerId = player.id;
  ws.sentState = null;
  send(ws, { type: 'joined', roomId: room.id, roomUrl: getRoomUrl(room.id), token: player.token, resumed,
    player: { id: player.id, name: player.name, team: player.team, characterId: player.characterId, isHost: player.isHost } });
  sendPlayerState(room, player);
  // 모두 연결을 끊었던 릴레이도 재접속하면 다음 대표를 다시 고릅니다.
  if (room.game.mode === 'relay' && (!room.game.relay || room.game.relay.lastResult)) startRelayDuel(room);
}

function resumePlayer(ws, message) {
  if (getPlayerBySocket(ws)) return;
  const room = rooms.get(normalizeRoomId(message.roomId));
  const playerId = typeof message.token === 'string' ? room?.playerTokens.get(message.token) : null;
  const player = playerId ? room.players.get(playerId) : null;
  if (!player) return send(ws, { type: 'resumeFailed', message: '이전 접속을 복구할 수 없어요. 방 코드와 닉네임으로 다시 입장해 주세요.' });
  attachPlayer(room, player, ws, true);
  broadcast(room);
}

function deleteRoom(room) {
  clearTimeout(room.broadcastTimer);
  rooms.delete(room.id);
}

function leavePlayer(ws) {
  const room = getRoomBySocket(ws);
  const player = getPlayerBySocket(ws);
  if (!player) return;
  socketRooms.delete(ws);
  room.players.delete(player.id);
  room.playerTokens.delete(player.token);
  if (![...room.players.values()].some((entry) => !entry.isAI)) return deleteRoom(room);
  if (player.isHost) {
    const humans = [...room.players.values()].filter((entry) => !entry.isAI);
    const next = humans.find((entry) => entry.ws?.readyState === 1) || humans[0];
    next.isHost = true;
    applyHostParticipation(room, next);
    if (room.sessionMode === 'waiting') resetRoomToLobby(room);
  }
  if (![...room.players.values()].some((entry) => !entry.isAI && entry.ws?.readyState === 1)) room.emptySince = Date.now();
  broadcast(room);
}

function createRoomAndJoin(ws, message) {
  if (getPlayerBySocket(ws)) {
    send(ws, { type: 'error', message: '이미 방에 들어와 있어요.' });
    return;
  }

  const name = sanitizeName(message.name);
  if (!name) {
    send(ws, { type: 'error', message: '닉네임을 한 글자 이상 입력해 주세요.' });
    return;
  }

  if (message.playMode != null && !['typing', 'tablet'].includes(message.playMode)) {
    send(ws, { type: 'error', message: '방 모드를 다시 선택해 주세요.' });
    return;
  }
  if (message.hostParticipation !== undefined && !HOST_PARTICIPATION_OPTIONS.some((option) => option.value === message.hostParticipation)) {
    send(ws, { type: 'error', message: '선생님 참가 방식을 다시 선택해 주세요.' });
    return;
  }
  if (rooms.size >= MAX_ROOMS) return send(ws, { type: 'error', message: '지금 열려 있는 방이 많아요. 잠시 뒤 다시 방을 만들어 주세요.' });
  const room = createRoom(message.playMode || 'typing', message.hostParticipation || 'auto');
  send(ws, { type: 'roomCreated', roomId: room.id, roomUrl: getRoomUrl(room.id) });
  joinPlayer(ws, { ...message, name, roomId: room.id });
}

function advanceRound(player, message) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  if (!player.isHost) {
    send(player.ws, { type: 'error', message: '선생님(방장)만 다음 라운드를 바로 시작할 수 있어요.' });
    return;
  }
  const game = room.game;
  // A delayed click or double tap must never skip a later round's explanation.
  if (!['intermission', 'roundIntro'].includes(game.phase) || message.phase !== game.phase || message.roundIndex !== game.roundIndex) return;
  const nextIndex = game.phase === 'intermission' ? game.roundIndex + 1 : game.roundIndex;
  if (room.sessionMode === 'waiting' && nextIndex === MODES.length) room.game.roundScores = [];
  beginRound(room, room.sessionMode === 'waiting' ? nextIndex % MODES.length : nextIndex);
}

function updateHostParticipation(player, message) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const fail = (text) => send(player.ws, { type: 'error', message: text });
  if (!player.isHost) return fail('선생님(방장)만 참가 방식을 바꿀 수 있어요.');
  if (room.game.phase !== 'lobby') return fail('선생님 참가 방식은 게임 시작 전 대기실에서 바꿔 주세요.');
  if (!HOST_PARTICIPATION_OPTIONS.some((option) => option.value === message.participation)) return fail('선생님 참가 방식을 다시 선택해 주세요.');
  room.hostParticipation = message.participation;
  applyHostParticipation(room, player);
  broadcast(room);
}

function updateScoreMultiplier(player, message) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const fail = (text) => send(player.ws, { type: 'error', message: text });
  if (!player.isHost) return fail('선생님(방장)만 점수 배율을 바꿀 수 있어요.');
  if (!SCORE_SETTING_PHASES.includes(room.game.phase)) return fail('점수 배율은 경기 화면에서 바꿀 수 있어요.');
  if (!SCORE_MULTIPLIER_LEVELS.includes(message.multiplier)) return fail('점수 배율은 1배부터 7배까지 선택해 주세요.');
  if (room.scoreMultiplier === message.multiplier) return;
  room.scoreMultiplier = message.multiplier;
  broadcast(room);
}

function updateRoomQuestions(player, message) {
  const room = getRoomForPlayer(player);
  if (!room) return;
  const fail = (text) => send(player.ws, { type: 'questionsUpdateResult', ok: false, message: text });
  if (!player.isHost) return fail('선생님(방장)만 문제를 바꿀 수 있어요.');
  if (room.game.phase !== 'lobby') return fail('문제는 게임을 시작하기 전 대기실에서만 바꿀 수 있어요.');
  let questions;
  if (message.type === 'uploadQuestions') {
    try { questions = validateCustomQuestions(message.questions); }
    catch (error) { return fail(error.message); }
  }
  room.questionRevision += 1;
  if (questions) {
    const fileName = typeof message.fileName === 'string' ? message.fileName.replace(/[\\/\x00-\x1f]/g, '').slice(0, 100) : '선생님 문제.csv';
    room.customQuestions = { fileName: fileName || '선생님 문제.csv', questions };
    const modes = room.playMode === 'tablet' ? TABLET_MODES : MODES;
    room.customModes = modes.map((mode, index) => mode.id === 'quiz' ? {
      ...mode,
      name: room.playMode === 'tablet' ? `선생님 퀴즈 ${index + 1}` : '선생님 객관식 퀴즈',
      description: `선생님이 올린 ${questions.length}개 문제에서 출제해요. 정답은 속도 보너스, 기본 오답 감점은 30점이에요.`,
    } : mode);
  } else {
    room.customQuestions = null;
    room.customModes = null;
  }
  resetPlayerProgress(room);
  send(player.ws, { type: 'questionsUpdateResult', ok: true, message: questions ? `${questions.length}개 문제를 이 방에 적용했어요.` : '기본 문제로 돌아왔어요.' });
  broadcast(room);
}

function handleMessage(ws, rawMessage) {
  if (!takeMessageToken(ws)) return;
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    send(ws, { type: 'error', message: '잘못된 요청입니다.' });
    return;
  }

  if (!message || typeof message !== 'object' || Array.isArray(message)) return;

  if (message.type === 'createRoom') {
    if (!loadGuard.canCreateRoom()) return send(ws, { type: 'error', code: 'server_busy', message: BUSY_MESSAGE });
    return createRoomAndJoin(ws, message);
  }
  if (message.type === 'join') return joinPlayer(ws, message);
  if (message.type === 'resume') return resumePlayer(ws, message);
  if (message.type === 'leave') return leavePlayer(ws);
  const player = getPlayerBySocket(ws);
  if (!player) return;

  if (message.type === 'uploadQuestions' || message.type === 'clearQuestions') return updateRoomQuestions(player, message);
  if (message.type === 'setScoreMultiplier') return updateScoreMultiplier(player, message);
  if (message.type === 'setHostParticipation') return updateHostParticipation(player, message);
  if (message.type === 'advanceRound') return advanceRound(player, message);
  if (message.type === 'startWaiting' || message.type === 'startAI') return startSoloMode(player, message);
  if (message.type === 'selectWaitingRound') return selectWaitingRound(player, message);
  if (message.type === 'start') return startGame(player);
  if (message.type === 'restart') return resetToLobby(player);
  if (['answer', 'choice', 'relayAnswer'].includes(message.type)) {
    if (message.type === 'answer') handleTypedAnswer(player, message.answer);
    if (message.type === 'choice') handleChoice(player, message.choice, message.promptId);
    if (message.type === 'relayAnswer') handleRelayAnswer(player, message.answer, message.deadline);
    // 다음 문제는 답한 학생에게 즉시 보냅니다. 반 전체 방송을 기다리지 않습니다.
    const room = getRoomForPlayer(player);
    if (room) sendPlayerState(room, player);
    return;
  }
  if (message.type === 'draft') return handleDraft(player, message);
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) {
    // 연결이 끊긴 방은 15분간 재접속용으로 보관하며 DB에 저장하지 않습니다.
    if (room.emptySince !== null) {
      if (now - room.emptySince >= 15 * 60_000) deleteRoom(room);
      continue;
    }
    const game = room.game;
    if (game.phase === 'round') {
      if (now >= game.roundEndsAt) finishRound(room);
      else if (game.mode === 'relay' && game.relay && now >= game.relay.deadline) finishRelayDuel(room);
      if (room.sessionMode === 'ai' && room.game.phase === 'round') answerAsAi(room, now);
    } else if (game.phase === 'placement' && now >= game.placementEndsAt) {
      finishPlacement(room);
    } else if (game.phase === 'teamReveal' && now >= game.teamRevealUntil) {
      queueRound(room, 0);
    } else if (game.phase === 'intermission' && now >= game.intermissionUntil) {
      const nextIndex = game.roundIndex + 1;
      if (room.sessionMode === 'waiting' && nextIndex === MODES.length) game.roundScores = [];
      beginRound(room, room.sessionMode === 'waiting' ? nextIndex % MODES.length : nextIndex);
    } else if (game.phase === 'wheel' && now >= game.wheelEndsAt) {
      queueRound(room, MODES.length);
    } else if (game.phase === 'roundIntro' && now >= game.roundIntroUntil) {
      beginRound(room, game.roundIndex);
    }
  }

  for (const room of rooms.values()) {
    if (room.emptySince === null && now - (room.lastBroadcastAt || 0) >= 500) broadcast(room);
  }
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  // /ws/s2/health 처럼 서버별 주소로도 상태를 알려 준다(선생님 화면이 가장 한가한 서버를 고를 때 쓴다).
  if (pathname === '/health' || SHARD_HEALTH_PATH.test(pathname)) {
    const playerCount = [...rooms.values()].reduce((total, room) => total + room.players.size, 0);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, shard: SHARD_ID, shards: SHARD_COUNT, players: playerCount, rooms: rooms.size, load: loadGuard.status() }));
    return;
  }

  const root = STATIC_ROOT;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(root, `.${requested}`);
  if (relative(root, filePath).startsWith('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    const target = fileStat.isDirectory() ? join(filePath, 'index.html') : filePath;
    if (extname(target) === '.mp4') {
      const size = fileStat.size;
      const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
      let start = 0;
      let end = size - 1;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (match && (match[1] || match[2])) {
          start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
          end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        }
        if (!match || (!match[1] && !match[2]) || start > end || start >= size) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      res.writeHead(req.headers.range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') res.end();
      else {
        const stream = createReadStream(target, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      }
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream', 'Cache-Control': target.startsWith(join(DIST, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(body);
  } catch {
    if (STATIC_ROOT === DIST) {
      const fallback = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
      res.end(fallback);
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  }
}

const httpServer = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    res.writeHead(500);
    res.end('Internal server error');
  });
});

// 상태 메시지(약 15KB JSON)를 0.5초마다 전원에게 보내므로 압축 효과가 크다.
// 20개 반 600명 실측: 전송량 161Mbps → 3Mbps. 대신 서버 CPU 약 2배, 메모리 약 +330MB.
// 브라우저는 permessage-deflate 를 기본 지원해 클라이언트 수정이 필요 없다. WS_COMPRESS=0 으로 끌 수 있다.
const websocketServer = new WebSocketServer({
  // /ws 와 서버별 /ws/s1~s8 을 모두 받으려고 업그레이드를 직접 처리한다(아래 httpServer.on('upgrade')).
  noServer: true,
  maxPayload: MAX_CSV_BYTES + 8_192,
  // 압축은 기본으로 끈다(2026-10-02). 바뀐 학생 줄만 보내면 메시지가 작아 압축 이득보다 비용(메시지마다 압축,
  // 학생 메시지 풀기)이 크다. 서버 노트북 실측으로 반당 CPU가 약 절반이 됐다. WS_COMPRESS=1 이면 다시 켠다.
  perMessageDeflate: process.env.WS_COMPRESS === '1' ? { zlibDeflateOptions: { level: 3, memLevel: 7 }, serverMaxWindowBits: 13, concurrencyLimit: 4, threshold: 512 } : false,
});
httpServer.on('upgrade', (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url || '/', 'http://localhost').pathname; } catch { socket.destroy(); return; }
  if (!WS_PATH.test(pathname)) { socket.destroy(); return; }
  websocketServer.handleUpgrade(request, socket, head, (ws) => websocketServer.emit('connection', ws, request));
});

websocketServer.on('connection', (ws, request) => {
  ws.supportsDelta = new URL(request.url, 'http://localhost').searchParams.get('delta') === '1';
  // 바뀐 학생 줄만 받아 합칠 줄 아는 새 화면(pu). 예전 화면은 players 전체를 받는다.
  ws.supportsRowPatch = ['1', '2'].includes(new URL(request.url, 'http://localhost').searchParams.get('rows'));
  ws.supportsFieldPatch = new URL(request.url, 'http://localhost').searchParams.get('rows') === '2'; // 바뀐 칸만(pf) 받는 화면
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => ws.close());
  ws.on('message', (message) => handleMessage(ws, message));
  ws.on('close', () => {
    const room = getRoomBySocket(ws);
    const player = getPlayerBySocket(ws);
    socketRooms.delete(ws);
    if (!player || player.ws !== ws) return;
    player.ws = null;
    player.disconnectedAt = Date.now();
    // 새로고침 중에도 방장 권한·팀·점수·문제 진행을 그대로 유지합니다.
    if (![...room.players.values()].some((entry) => !entry.isAI && entry.ws?.readyState === 1)) room.emptySince = Date.now();
    broadcast(room);
  });
});

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`말모이 줄다리기 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

setInterval(tick, 250).unref();
setInterval(() => {
  for (const ws of websocketServer.clients) {
    if (loadGuard.shouldTerminate(ws)) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 12_000).unref();
