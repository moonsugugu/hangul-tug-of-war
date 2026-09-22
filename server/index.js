import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8787);
const REFERENCE_CPM = 120;
const RELAY_LIMIT_MS = 12_000;
const ROUND_MULTIPLIERS = [1, 1.1, 1.3, 1.5];

const WORD_PROMPTS = [
  { word: '윤슬', meaning: '햇빛이나 달빛이 물결에 비쳐 반짝이는 모습', example: '강물 위로 윤슬이 반짝였습니다.' },
  { word: '여우비', meaning: '햇빛이 있는 날 잠깐 내리는 비', example: '맑은 하늘에서 여우비가 내렸습니다.' },
  { word: '너울', meaning: '큰 물결', example: '바다에 너울이 일었습니다.' },
  { word: '모꼬지', meaning: '여러 사람이 모이는 일', example: '친구들과 즐거운 모꼬지를 열었습니다.' },
  { word: '미리내', meaning: '은하수', example: '밤하늘에 미리내가 흐릅니다.' },
  { word: '도란도란', meaning: '여럿이 정답게 이야기하는 모양', example: '아이들이 도란도란 이야기를 나눕니다.' },
  { word: '바람꽃', meaning: '바람에 흔들리는 꽃처럼 피어난 작은 꽃', example: '들판에 바람꽃이 피었습니다.' },
  { word: '한가람', meaning: '큰 강을 뜻하는 우리말', example: '한가람처럼 넓은 마음을 가져요.' },
];

const QUIZ_PROMPTS = [
  { meaning: '햇빛이 있는 날 잠깐 내리는 비', choices: ['너울', '여우비', '미리내'], answer: '여우비' },
  { meaning: '햇빛이나 달빛이 물결에 비쳐 반짝이는 모습', choices: ['윤슬', '모꼬지', '바람꽃'], answer: '윤슬' },
  { meaning: '큰 물결', choices: ['도란도란', '한가람', '너울'], answer: '너울' },
  { meaning: '여러 사람이 모이는 일', choices: ['모꼬지', '여우비', '윤슬'], answer: '모꼬지' },
  { meaning: '은하수', choices: ['미리내', '바람꽃', '너울'], answer: '미리내' },
  { meaning: '여럿이 정답게 이야기하는 모양', choices: ['한가람', '도란도란', '여우비'], answer: '도란도란' },
];

const REPAIR_PROMPTS = [
  {
    question: '한글 날을 맞아 우리말을 사랑해요',
    answer: '한글날을 맞아 우리말을 사랑해요',
    explanation: '기념일 이름인 한글날은 붙여 씁니다.',
  },
  {
    question: '우리말을아끼고한글을사랑합시다',
    answer: '우리말을 아끼고 한글을 사랑합시다',
    explanation: '문장의 의미가 잘 드러나도록 낱말 사이를 띄어 씁니다.',
  },
  {
    question: '세종대왕님고맙습니다',
    answer: '세종대왕님, 고맙습니다',
    explanation: '부르는 말 뒤에는 쉼표를 넣어 문장을 또렷하게 만들 수 있습니다.',
  },
  {
    question: '한글은누구나쉽게배울수있는문자입니다.',
    answer: '한글은 누구나 쉽게 배울 수 있는 문자입니다.',
    explanation: '문장 속 낱말을 알맞게 띄어 씁니다.',
  },
];

const RELAY_PROMPTS = [
  '우리말을 아끼고 한글을 소중히 지켜요.',
  '한글날에는 우리말의 아름다움을 함께 느껴요.',
  '세종대왕님, 누구나 읽고 쓰는 세상을 열어 주셔서 고맙습니다.',
  '정확한 말과 따뜻한 마음으로 서로를 존중해요.',
];

const MODES = [
  { id: 'word', name: '말모이 기본전', description: '순우리말을 빠르고 정확하게 입력해요.', duration: 45_000 },
  { id: 'quiz', name: '뜻풀이 객관식 역전전', description: '뜻을 읽고 알맞은 순우리말을 골라요.', duration: 60_000 },
  { id: 'repair', name: '바른말 수리공', description: '띄어쓰기와 문장을 바르게 고쳐요.', duration: 60_000 },
  { id: 'relay', name: '훈민정음 랜덤 릴레이', description: '랜덤 대표 선수끼리 한글 문장으로 대결해요.', duration: 75_000 },
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const players = new Map();
let game = createGame();
let lastBroadcastAt = 0;

function createGame() {
  return {
    phase: 'lobby',
    roundIndex: -1,
    mode: null,
    roundStartedAt: 0,
    roundEndsAt: 0,
    intermissionUntil: 0,
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

function getActivePlayers() {
  return [...players.values()].filter((player) => !player.spectator);
}

function getCounts() {
  if (game.phase !== 'lobby' && game.rosterCounts.blue + game.rosterCounts.white > 0) {
    return { ...game.rosterCounts };
  }

  return getActivePlayers().reduce((counts, player) => {
    counts[player.team] += 1;
    return counts;
  }, { blue: 0, white: 0 });
}

function getMultipliers() {
  const counts = getCounts();
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

function normalizeWord(value) {
  return String(value || '').normalize('NFKC').trim();
}

function normalizeSentence(value) {
  return String(value || '').normalize('NFKC').replace(/\r/g, '').trim();
}

function getMode() {
  return MODES[game.roundIndex] || null;
}

function getPromptFor(player) {
  if (game.phase !== 'round' || !player || player.spectator) return null;
  const mode = getMode();
  if (!mode) return null;

  if (mode.id === 'word') {
    const index = player.progress.promptIndex % WORD_PROMPTS.length;
    const prompt = WORD_PROMPTS[index];
    return { kind: 'word', id: `word-${index}`, word: prompt.word, length: [...prompt.word].length };
  }

  if (mode.id === 'quiz') {
    const index = player.progress.promptIndex % QUIZ_PROMPTS.length;
    const prompt = QUIZ_PROMPTS[index];
    return { kind: 'quiz', id: `quiz-${index}`, meaning: prompt.meaning, choices: prompt.choices };
  }

  if (mode.id === 'repair') {
    const index = player.progress.promptIndex % REPAIR_PROMPTS.length;
    const prompt = REPAIR_PROMPTS[index];
    return { kind: 'repair', id: `repair-${index}`, question: prompt.question };
  }

  if (mode.id === 'relay' && game.relay) {
    const isSelected = game.relay.blueId === player.id || game.relay.whiteId === player.id;
    return {
      kind: 'relay',
      selected: isSelected,
      selectedTeam: game.relay.blueId === player.id ? 'blue' : game.relay.whiteId === player.id ? 'white' : null,
      prompt: game.relay.prompt,
      relayDeadline: game.relay.deadline,
    };
  }

  return null;
}

function publicStateFor(player) {
  const counts = getCounts();
  const multipliers = getMultipliers();
  const total = game.scores.blue + game.scores.white;
  const difference = game.scores.blue - game.scores.white;
  const ropePosition = Math.max(7, Math.min(93, 50 + (difference / Math.max(total, 100)) * 38));
  const mode = getMode();

  return {
    type: 'state',
    phase: game.phase,
    roundIndex: game.roundIndex,
    roundNumber: game.roundIndex + 1,
    totalRounds: MODES.length,
    mode: mode ? { ...mode } : null,
    timeRemainingMs: game.phase === 'round' ? Math.max(0, game.roundEndsAt - Date.now()) : 0,
    intermissionRemainingMs: game.phase === 'intermission' ? Math.max(0, game.intermissionUntil - Date.now()) : 0,
    scores: game.scores,
    rawScores: game.rawScores,
    roundScores: game.roundScores,
    counts,
    multipliers,
    ropePosition,
    winner: game.winner,
    notice: game.notice,
    self: player ? {
      id: player.id,
      name: player.name,
      team: player.team,
      isHost: player.isHost,
      spectator: player.spectator,
    } : null,
    players: [...players.values()].map((entry) => ({
      id: entry.id,
      name: entry.name,
      team: entry.team,
      isHost: entry.isHost,
      spectator: entry.spectator,
      connected: entry.ws.readyState === entry.ws.OPEN,
    })),
    prompt: getPromptFor(player),
    relay: game.relay ? {
      blueId: game.relay.blueId,
      whiteId: game.relay.whiteId,
      prompt: game.relay.prompt,
      deadline: game.relay.deadline,
      blueSubmitted: Boolean(game.relay.submissions.blue),
      whiteSubmitted: Boolean(game.relay.submissions.white),
      lastResult: game.relay.lastResult || null,
    } : null,
  };
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast() {
  for (const player of players.values()) {
    send(player.ws, publicStateFor(player));
  }
  lastBroadcastAt = Date.now();
}

function getPlayerBySocket(ws) {
  return [...players.values()].find((player) => player.ws === ws);
}

function setNotice(text) {
  game.notice = text;
  setTimeout(() => {
    if (game.notice === text) {
      game.notice = '';
      broadcast();
    }
  }, 3_000);
}

function addTeamScore(team, score) {
  const multiplier = getMultipliers()[team];
  const weighted = Math.max(0, score) * ROUND_MULTIPLIERS[game.roundIndex];
  game.rawScores[team] += weighted;
  game.scores[team] += weighted * multiplier;

  const ropePosition = publicStateFor(null).ropePosition;
  if (ropePosition <= 7 || ropePosition >= 93) {
    endGame(ropePosition >= 93 ? 'blue' : 'white');
  }
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

function resetPlayerProgress() {
  const now = Date.now();
  for (const player of getActivePlayers()) {
    player.progress = { promptIndex: 0, promptStartedAt: now };
  }
}

function beginRound(index) {
  const mode = MODES[index];
  if (!mode) return;

  game.phase = 'round';
  game.roundIndex = index;
  game.mode = mode.id;
  game.roundStartedAt = Date.now();
  game.roundEndsAt = Date.now() + mode.duration;
  game.notice = `${index + 1}라운드 · ${mode.name}`;
  game.relay = null;
  game.relayUsed = { blue: new Set(), white: new Set() };
  resetPlayerProgress();

  if (mode.id === 'relay') startRelayDuel();
  broadcast();
}

function finishRound() {
  if (game.phase !== 'round') return;
  const roundScore = {
    round: game.roundIndex + 1,
    mode: getMode()?.name || '',
    blue: Math.round(game.scores.blue - (game.roundScores.reduce((sum, item) => sum + item.blue, 0))),
    white: Math.round(game.scores.white - (game.roundScores.reduce((sum, item) => sum + item.white, 0))),
  };
  game.roundScores.push(roundScore);
  game.relay = null;

  if (game.roundIndex >= MODES.length - 1) {
    const winner = game.scores.blue === game.scores.white ? 'draw' : game.scores.blue > game.scores.white ? 'blue' : 'white';
    endGame(winner);
    return;
  }

  game.phase = 'intermission';
  game.intermissionUntil = Date.now() + 4_000;
  game.notice = `${game.roundIndex + 1}라운드 종료 · 다음 라운드를 준비하세요.`;
  broadcast();
}

function endGame(winner) {
  if (game.phase === 'results') return;
  game.phase = 'results';
  game.winner = winner;
  game.roundEndsAt = 0;
  game.relay = null;
  game.notice = winner === 'draw' ? '무승부! 두 팀 모두 멋진 한글 실력을 보여주었어요.' : `${winner === 'blue' ? '청팀' : '백팀'} 승리!`;
  broadcast();
}

function startRelayDuel() {
  if (game.phase !== 'round' || game.mode !== 'relay') return;
  const byTeam = {
    blue: getActivePlayers().filter((player) => player.team === 'blue'),
    white: getActivePlayers().filter((player) => player.team === 'white'),
  };
  if (!byTeam.blue.length || !byTeam.white.length) return;

  const selected = {};
  for (const team of ['blue', 'white']) {
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
  broadcast();
}

function finishRelayDuel() {
  const relay = game.relay;
  if (!relay || relay.lastResult) return;

  const blue = relay.submissions.blue;
  const white = relay.submissions.white;
  const blueScore = blue?.exact ? Math.max(0, 60 + Math.min(40, 40 * (1 - blue.elapsedMs / RELAY_LIMIT_MS))) : 0;
  const whiteScore = white?.exact ? Math.max(0, 60 + Math.min(40, 40 * (1 - white.elapsedMs / RELAY_LIMIT_MS))) : 0;

  if (blueScore) addTeamScore('blue', blueScore);
  if (whiteScore) addTeamScore('white', whiteScore);

  const winner = blueScore === whiteScore ? 'draw' : blueScore > whiteScore ? 'blue' : 'white';
  relay.lastResult = { winner, blueScore, whiteScore };
  broadcast();

  setTimeout(() => {
    if (game.phase === 'round' && game.mode === 'relay') startRelayDuel();
  }, 1_800);
}

function handleTypedAnswer(player, answer) {
  if (game.phase !== 'round' || !player.progress || !getMode()) return;
  const mode = getMode();
  if (!['word', 'repair'].includes(mode.id)) return;

  const index = player.progress.promptIndex % (mode.id === 'word' ? WORD_PROMPTS.length : REPAIR_PROMPTS.length);
  const source = mode.id === 'word' ? WORD_PROMPTS[index] : REPAIR_PROMPTS[index];
  const expected = mode.id === 'word' ? source.word : source.answer;
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const result = calculateTypedScore(answer, expected, elapsedMs, mode.id);
  addTeamScore(player.team, result.score);
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();

  send(player.ws, {
    type: 'answerResult',
    correct: result.exact,
    score: result.score,
    accuracy: result.accuracy,
    cpm: result.cpm,
    word: mode.id === 'word' ? source.word : undefined,
    meaning: mode.id === 'word' ? source.meaning : undefined,
    example: mode.id === 'word' ? source.example : undefined,
    correctAnswer: mode.id === 'repair' ? source.answer : undefined,
    explanation: mode.id === 'repair' ? source.explanation : undefined,
  });
  broadcast();
}

function handleChoice(player, choice) {
  if (game.phase !== 'round' || getMode()?.id !== 'quiz') return;
  const index = player.progress.promptIndex % QUIZ_PROMPTS.length;
  const prompt = QUIZ_PROMPTS[index];
  const elapsedMs = Date.now() - player.progress.promptStartedAt;
  const correct = choice === prompt.answer;
  const speedBonus = Math.max(0, 40 * (1 - Math.min(elapsedMs, 8_000) / 8_000));
  const score = correct ? 60 + speedBonus : 0;

  addTeamScore(player.team, score);
  player.progress.promptIndex += 1;
  player.progress.promptStartedAt = Date.now();
  send(player.ws, {
    type: 'choiceResult',
    correct,
    score,
    answer: prompt.answer,
    meaning: prompt.meaning,
  });
  broadcast();
}

function handleRelayAnswer(player, answer) {
  const relay = game.relay;
  if (game.phase !== 'round' || game.mode !== 'relay' || !relay) return;
  const team = relay.blueId === player.id ? 'blue' : relay.whiteId === player.id ? 'white' : null;
  if (!team || relay.submissions[team]) return;

  const elapsedMs = Date.now() - relay.startedAt;
  relay.submissions[team] = {
    exact: normalizeSentence(answer) === normalizeSentence(relay.prompt),
    elapsedMs,
  };
  send(player.ws, { type: 'relayAnswerResult', correct: relay.submissions[team].exact });
  if (relay.submissions.blue && relay.submissions.white) finishRelayDuel();
  else broadcast();
}

function startGame(player) {
  if (!player.isHost || game.phase !== 'lobby') return;
  const counts = getCounts();
  if (counts.blue < 1 || counts.white < 1) {
    send(player.ws, { type: 'error', message: '청팀과 백팀에 각각 한 명 이상 있어야 시작할 수 있어요.' });
    return;
  }

  game = createGame();
  game.rosterCounts = counts;
  for (const entry of players.values()) {
    entry.spectator = false;
  }
  beginRound(0);
}

function resetToLobby(player) {
  if (!player.isHost) return;
  game = createGame();
  for (const entry of players.values()) {
    entry.spectator = false;
    entry.progress = { promptIndex: 0, promptStartedAt: 0 };
  }
  broadcast();
}

function joinPlayer(ws, message) {
  if (game.phase !== 'lobby') {
    send(ws, { type: 'error', message: '게임이 이미 진행 중입니다. 다음 게임을 기다려 주세요.' });
    return;
  }

  const name = sanitizeName(message.name);
  if (!name) {
    send(ws, { type: 'error', message: '닉네임을 한 글자 이상 입력해 주세요.' });
    return;
  }

  const counts = getCounts();
  const team = counts.blue <= counts.white ? 'blue' : 'white';
  const player = {
    id: randomUUID(),
    ws,
    name,
    team,
    isHost: players.size === 0,
    spectator: false,
    progress: { promptIndex: 0, promptStartedAt: 0 },
  };
  players.set(player.id, player);
  send(ws, { type: 'joined', player: { id: player.id, name: player.name, team: player.team, isHost: player.isHost } });
  broadcast();
}

function handleMessage(ws, rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    send(ws, { type: 'error', message: '잘못된 요청입니다.' });
    return;
  }

  const player = getPlayerBySocket(ws);
  if (message.type === 'join') return joinPlayer(ws, message);
  if (!player) return;

  if (message.type === 'start') return startGame(player);
  if (message.type === 'restart') return resetToLobby(player);
  if (message.type === 'answer') return handleTypedAnswer(player, message.answer);
  if (message.type === 'choice') return handleChoice(player, message.choice);
  if (message.type === 'relayAnswer') return handleRelayAnswer(player, message.answer);
}

function tick() {
  const now = Date.now();
  if (game.phase === 'round') {
    if (game.mode === 'relay' && game.relay && now >= game.relay.deadline) finishRelayDuel();
    if (game.phase === 'round' && now >= game.roundEndsAt) finishRound();
  } else if (game.phase === 'intermission' && now >= game.intermissionUntil) {
    beginRound(game.roundIndex + 1);
  }

  if (now - lastBroadcastAt >= 500) broadcast();
}

async function serveStatic(req, res) {
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, players: players.size, phase: game.phase }));
    return;
  }

  const root = existsSync(DIST) ? DIST : ROOT;
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
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    if (existsSync(DIST)) {
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

const websocketServer = new WebSocketServer({ server: httpServer, path: '/ws' });
websocketServer.on('connection', (ws) => {
  ws.on('message', (message) => handleMessage(ws, message));
  ws.on('close', () => {
    const player = getPlayerBySocket(ws);
    if (!player) return;
    players.delete(player.id);
    if (game.phase === 'lobby' && player.isHost) {
      const nextHost = players.values().next().value;
      if (nextHost) nextHost.isHost = true;
    }
    broadcast();
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`말모이 줄다리기 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

setInterval(tick, 250);
