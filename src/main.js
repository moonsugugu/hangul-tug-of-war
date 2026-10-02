import { openQrDialog } from './qr-dialog.js';
import { loadSession, saveSession, forgetSession } from './session.js';
import './styles.css';
import { mountTugScene } from './tugScene.js';
import { startBgm, stopBgm, unlockSoundEffects, playVictorySound } from './bgm.js';
import QRCode from 'qrcode';
import { MAX_CSV_BYTES, MAX_CUSTOM_QUESTIONS, parseQuestionCsv } from '../shared/question-csv.js';
import { SCORE_MULTIPLIER_LEVELS, SCORE_SETTING_PHASES, ANSWER_REVIEW_MS } from '../shared/score-settings.js';
import { HOST_PARTICIPATION_OPTIONS } from '../shared/teacher-participation.js';
import { AI_LEVELS, getAiLevel } from '../shared/ai-levels.js';

const app = document.querySelector('#app');
const initialRoomId = normalizeRoomId(new URLSearchParams(window.location.search).get('room'));
const initialSession = loadSession(initialRoomId);
const state = {
  connected: false,
  joined: false,
  roomId: initialRoomId,
  roomUrl: '',
  data: null,
  draft: '',
  result: null,
  notice: '',
  soundEnabled: false,
  nickname: initialSession?.name || '',
  selectedCharacter: initialSession?.characterId || 'bear',
  selectedPlayMode: 'typing',
  selectedAiLevel: 1,
  pendingChoiceId: null,
  uploadingQuestions: false,
  questionUploadStatus: '',
  questionUploadError: false,
  wrongAnswer: null,
};

let socket;
let reconnectTimer;
let reconnectAttempts = 0;
let resumeToken = initialSession?.token || null;
let qrCache = { url: '', promise: null };
let qrDialog;
let lastViewKey = '';
let lastPromptKey = '';
let tugScene = null;
let lastCelebrationKey = '';
let isComposing = false;
let pendingRender = null;
let pendingDraftReset = false;
let wrongAnswerTimer;
let resultToastTimer;

function renderWhenReady(kind) {
  if (isComposing) {
    pendingRender = kind === 'full' ? 'full' : pendingRender || kind;
    return;
  }
  if (kind === 'full') render();
  else renderPromptOnly();
}
const NAME_FLASH_MS = 1_200;
// Shared with every mounted scene so a flash survives the scene being rebuilt.
const nameFlashUntil = new Map();
const lastScoreCounts = new Map();

function trackScoreFlashes(players = []) {
  const now = Date.now();
  for (const player of players) {
    const previous = lastScoreCounts.get(player.id);
    if (previous !== undefined && player.scoreCount > previous) nameFlashUntil.set(player.id, now + NAME_FLASH_MS);
    lastScoreCounts.set(player.id, player.scoreCount);
  }
}

const characterOptions = [
  { id: 'rabbit', name: '토끼', emoji: '🐰', description: '빠른 손' },
  { id: 'bear', name: '곰', emoji: '🐻', description: '든든한 힘' },
  { id: 'cat', name: '고양이', emoji: '🐱', description: '날쌘 집중력' },
  { id: 'chick', name: '병아리', emoji: '🐥', description: '톡톡한 기세' },
  { id: 'panda', name: '판다', emoji: '🐼', description: '차분한 끈기' },
  { id: 'sheep', name: '양', emoji: '🐑', description: '포근한 응원' },
  { id: 'fox', name: '여우', emoji: '🦊', description: '영리한 타자' },
  { id: 'penguin', name: '펭귄', emoji: '🐧', description: '끝까지 착착' },
];

const modeLabels = {
  word: '말모이 기본전',
  quiz: '뜻풀이 객관식 역전전',
  repair: '바른말 수리공',
  relay: '훈민정음 랜덤 릴레이',
};

const roundGuides = {
  word: '화면에 나온 순우리말을 정확히 입력하세요. 정확하고 빠를수록 줄을 더 당깁니다.',
  quiz: '네 가지 보기 중 정답을 고르세요. 기본 오답 감점은 30점이며 설정한 점수 배율을 곱해요. 오답 해설은 3초 동안 보여 줘요.',
  repair: '잘못 붙은 문장을 올바르게 띄어 써서 입력하세요.',
  relay: '기본 대표 정답은 줄 2칸, 응원 정답은 1점이며 설정한 점수 배율을 곱해요. 제한시간까지 대표가 계속 바뀝니다.',
};

function getRoundGuide(mode) {
  if (mode?.id === 'quiz') return `${mode.description || ''} 기본 정답 60점 + 속도 보너스 최대 40점, 기본 오답 −30점에 전체 점수 배율을 곱해요. 오답 해설은 3초 동안 보여 줘요.`;
  return roundGuides[mode?.id] || mode?.description || '';
}

function renderAdvanceRoundButton(data) {
  return data.self?.isHost ? '<button type="button" id="advance-round-button" class="primary-button compact">다음 라운드 바로 시작 <span>→</span></button>' : '<p class="muted">설명을 읽어 보세요. 대기 시간이 끝나면 자동으로 시작해요.</p>';
}

function winningTeamForCelebration(data) {
  if (data.sessionMode === 'waiting') return null;
  if (!['intermission', 'wheel', 'results'].includes(data.phase)) return null;
  const lastRound = data.roundScores?.at(-1);
  if (lastRound?.round !== data.roundNumber) return null;
  return data.phase === 'results' ? data.winner : lastRound.winner;
}

function celebrateWinIfNeeded(data) {
  const winner = winningTeamForCelebration(data);
  if (!winner) return;
  const key = `${data.roomId}:${data.roundNumber}:${winner}`;
  if (key === lastCelebrationKey) return;
  lastCelebrationKey = key;
  void playVictorySound().catch(() => {});
}

const roundModes = [
  { id: 'word' },
  { id: 'quiz' },
  { id: 'repair' },
  { id: 'relay' },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeRoomId(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function updateRoomUrl(roomId) {
  const url = new URL(window.location.href);
  if (roomId) url.searchParams.set('room', roomId);
  else url.searchParams.delete('room');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.port === '5173' ? `${location.hostname}:8787` : location.host;
  clearTimeout(reconnectTimer);
  socket = new WebSocket(`${protocol}://${host}/ws?delta=1`);
  const currentSocket = socket;

  socket.addEventListener('open', () => {
    if (socket !== currentSocket) return;
    state.connected = true;
    if (resumeToken && state.roomId) send({ type: 'resume', roomId: state.roomId, token: resumeToken });
    render();
  });
  socket.addEventListener('close', (event) => {
    if (socket !== currentSocket) return;
    state.connected = false;
    state.joined = false;
    state.uploadingQuestions = false;
    render();
    // 같은 참가자를 다른 탭에서 열면 이전 탭의 자동 복구 경쟁을 막습니다.
    if (event.code === 1000) { showNotice('다른 화면에서 접속했어요. 이 화면을 사용하려면 새로고침해 주세요.'); return; }
    reconnectTimer = setTimeout(connect, Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempts++, 5)));
  });
  socket.addEventListener('message', (event) => {
    if (socket !== currentSocket) return;
    let message = JSON.parse(event.data);
    if (message.type === 'roomCreated') {
      state.roomId = normalizeRoomId(message.roomId);
      state.roomUrl = message.roomUrl || state.roomUrl;
      updateRoomUrl(state.roomId);
      render();
      return;
    }
    if (message.type === 'resumeFailed') {
      forgetSession(state.roomId);
      resumeToken = null;
      state.data = null;
      lastViewKey = '';
      render();
      showNotice(message.message);
      return;
    }
    if (message.type === 'joined') {
      reconnectAttempts = 0;
      resumeToken = message.token;
      if (message.token) saveSession(message.roomId, { token: message.token, name: message.player.name, characterId: message.player.characterId });
      state.nickname = message.player.name;
      state.selectedCharacter = message.player.characterId;
      lastViewKey = '';
      lastPromptKey = '';
      state.data = null;
      state.roomId = normalizeRoomId(message.roomId) || state.roomId;
      state.roomUrl = message.roomUrl || state.roomUrl;
      updateRoomUrl(state.roomId);
      state.joined = true;
      state.data = state.data || {};
      render();
      return;
    }
    if (message.type === 'state') {
      message = message.full === false ? { ...state.data, ...message } : message;
      state.roomId = normalizeRoomId(message.roomId) || state.roomId;
      state.roomUrl = message.roomUrl || state.roomUrl;
      state.data = message;
      if (message.sessionMode === 'ai') state.selectedAiLevel = message.aiLevel;
      if (message.prompt?.id !== state.pendingChoiceId) state.pendingChoiceId = null;
      state.joined = Boolean(message.self);
      celebrateWinIfNeeded(message);
      trackScoreFlashes(message.players);
      updateDynamic();
      // The page (and its 3D arena) is rebuilt only when the page itself changes;
      // a new question only swaps the prompt card so the arena never blanks out.
      const viewKey = [
        message.phase,
        message.sessionMode,
        message.aiLevel,
        message.mode?.id,
        message.roundIndex,
        message.questionSet?.revision,
        message.counts?.blue,
        message.counts?.white,
        message.self?.team,
        message.self?.isHost,
        message.self?.spectator,
        message.hostParticipation,
        message.players?.map((player) => `${player.id}:${player.connected}:${player.characterId}:${player.team}`).join(','),
      ].join('|');
      const promptKey = [
        message.prompt?.id,
        message.relay?.blueId,
        message.relay?.whiteId,
        message.relay?.deadline,
        message.prompt?.submitted,
      ].join('|');
      const promptChanged = promptKey !== lastPromptKey;
      if (promptChanged) {
        state.draft = '';
        if (isComposing) pendingDraftReset = true;
      }
      if (viewKey !== lastViewKey) {
        lastViewKey = viewKey;
        lastPromptKey = promptKey;
        renderWhenReady('full');
      } else if (promptChanged) {
        lastPromptKey = promptKey;
        renderWhenReady('prompt');
      }
      return;
    }
    if (message.type === 'questionsUpdateResult') {
      state.uploadingQuestions = false;
      state.questionUploadStatus = message.message;
      state.questionUploadError = !message.ok;
      refreshTeacherSettings();
      return;
    }
    if (message.type === 'answerResult' || message.type === 'choiceResult') {
      const result = { ...message, score: message.score * (message.scoreMultiplier || 1) };
      state.draft = '';
      if (!message.correct) {
        showWrongAnswer(result);
        return;
      }
      state.result = result;
      renderResultToast();
      return;
    }
    if (message.type === 'placementResult') {
      state.result = {
        correct: message.correct,
        score: message.keystrokes,
        unit: '타',
        title: message.correct ? '정확해요!' : '틀린 글자는 빼고 셌어요',
      };
      state.draft = '';
      renderResultToast();
      return;
    }
    if (message.type === 'practiceResult') {
      state.result = {
        correct: message.correct,
        score: message.keystrokes,
        unit: '타',
        title: message.correct ? '연습 성공!' : '다음 낱말도 연습해 봐요',
        meaning: message.meaning,
        example: message.example,
        answer: message.word,
      };
      state.draft = '';
      renderResultToast();
      return;
    }
    if (message.type === 'relayAnswerResult') {
      const multiplier = message.scoreMultiplier || 1;
      const result = { ...message, score: message.score * multiplier, title: message.representative ? `대표 정답! 줄 ${2 * multiplier}칸 이동!` : `응원 점수 +${multiplier}점!` };
      state.draft = '';
      if (!message.correct) { showWrongAnswer(result); return; }
      state.result = result;
      renderResultToast();
      return;
    }
    if (message.type === 'timeoutScore') {
      state.result = {
        correct: true,
        score: message.score * (message.scoreMultiplier || 1),
        title: message.relay
          ? message.representative ? '시간 종료! 대표가 쓴 만큼 줄을 당겨요' : '시간 종료! 응원 부분 점수'
          : '시간 종료! 입력한 만큼 부분 점수',
      };
      state.draft = '';
      renderResultToast();
      return;
    }
    if (message.type === 'error') {
      showNotice(message.message);
    }
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function showNotice(message) {
  state.notice = message;
  renderNotice();
  window.setTimeout(() => {
    if (state.notice === message) {
      state.notice = '';
      renderNotice();
    }
  }, 3_000);
}

function join() {
  const input = document.querySelector('#nickname');
  const name = (state.nickname || input?.value || '').trim();
  if (!name) {
    showNotice('닉네임을 입력해 주세요.');
    input?.focus();
    return;
  }
  if (!state.roomId) {
    showNotice('방을 만들거나 방 코드를 입력해 주세요.');
    return;
  }
  const session = loadSession(state.roomId);
  if (session) { resumeToken = session.token; send({ type: 'resume', roomId: state.roomId, token: resumeToken }); }
  else send({ type: 'join', roomId: state.roomId, name, characterId: state.selectedCharacter });
}

function createRoom() {
  const input = document.querySelector('#nickname');
  const name = (state.nickname || input?.value || '').trim();
  if (!name) {
    showNotice('닉네임을 입력해 주세요.');
    input?.focus();
    return;
  }
  send({ type: 'createRoom', name, characterId: state.selectedCharacter, playMode: state.selectedPlayMode, hostParticipation: 'observe' });
}

function joinByRoomCode() {
  const input = document.querySelector('#room-code');
  const roomId = normalizeRoomId(input?.value);
  if (roomId.length !== 6) {
    showNotice('방 코드는 6자리예요.');
    input?.focus();
    return;
  }
  state.roomId = roomId;
  updateRoomUrl(roomId);
  join();
}

function clearRoom() {
  if (state.joined) send({ type: 'leave' });
  forgetSession(state.roomId);
  resumeToken = null;
  state.joined = false;
  state.data = null;
  qrDialog?.close();
  state.roomId = '';
  state.roomUrl = '';
  updateRoomUrl('');
  render();
}

function getRoomShareUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', state.roomId);
  return url.toString();
}

async function copyRoomLink() {
  try {
    await navigator.clipboard.writeText(getRoomShareUrl());
    showNotice('방 초대 링크를 복사했어요.');
  } catch {
    showNotice('주소창의 방 링크를 복사해 공유해 주세요.');
  }
}

function roomQrSource() {
  const url = getRoomShareUrl();
  if (qrCache.url !== url) qrCache = { url, promise: QRCode.toString(url, {
    type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#2f2b37', light: '#fffdf9' },
  }).then((svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`) };
  return qrCache.promise;
}

async function showRoomQr() {
  if (qrDialog?.open || !state.roomId) return;
  const roomId = state.roomId;
  try {
    const src = await roomQrSource();
    if (state.roomId !== roomId || qrDialog?.open) return;
    qrDialog = openQrDialog({ src, roomId, url: getRoomShareUrl() });
  } catch { showNotice('QR을 만들지 못했어요. 방 코드나 초대 링크를 사용해 주세요.'); }
}

async function renderRoomQr() {
  const images = document.querySelectorAll('#room-qr, [data-room-qr]');
  if (!images.length || !state.roomId) return;
  try {
    const src = await roomQrSource();
    for (const image of images) if (image.isConnected) image.src = src;
  } catch { showNotice('QR을 만들지 못했어요. 방 코드나 초대 링크를 사용해 주세요.'); }
}

function renderTeacherQr() {
  if (!state.joined || !state.data?.self?.isHost) return '';
  return `<button id="teacher-join-qr" type="button" class="teacher-join-qr" aria-label="학생 입장 QR 크게 보기"><img data-room-qr alt="학생 입장 QR" /><span><small>학생 입장 · 다시 접속</small><b>${escapeHtml(state.roomId)}</b><small>눌러서 크게 보기</small></span></button>`;
}

function startGame() {
  send({ type: 'start' });
}

function restartGame() {
  send({ type: 'restart' });
}

function submitAnswer() {
  const prompt = state.data?.prompt;
  if (state.wrongAnswer || !prompt || !['word', 'repair', 'placement', 'practice'].includes(prompt.kind)) return;
  const answer = document.querySelector('#answer-input')?.value ?? state.draft;
  if (!answer.trim()) return;
  send({ type: 'answer', answer });
}

function submitChoice(choice) {
  const prompt = state.data?.prompt;
  if (!state.connected || state.wrongAnswer || prompt?.kind !== 'quiz' || state.pendingChoiceId === prompt.id) return;
  state.pendingChoiceId = prompt.id;
  document.querySelectorAll('[data-choice]').forEach((button) => { button.disabled = true; });
  send({ type: 'choice', choice, promptId: prompt.id });
}

async function uploadCsvQuestions(file) {
  if (!file || state.uploadingQuestions) return;
  state.uploadingQuestions = true;
  state.questionUploadStatus = 'CSV 파일을 확인하고 있어요…';
  state.questionUploadError = false;
  refreshTeacherSettings();
  try {
    if (!/\.csv$/i.test(file.name)) throw new Error('CSV 파일을 선택해 주세요.');
    if (file.size > MAX_CSV_BYTES) throw new Error('CSV 파일은 256KB 이내로 올려 주세요.');
    const bytes = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch {
      try { text = new TextDecoder('euc-kr', { fatal: true }).decode(bytes); }
      catch { throw new Error('파일의 글자를 읽을 수 없어요. CSV UTF-8로 저장해서 다시 올려 주세요.'); }
    }
    const questions = parseQuestionCsv(text);
    if (!state.connected || socket?.readyState !== WebSocket.OPEN) throw new Error('서버 연결을 확인한 뒤 다시 올려 주세요.');
    if (!state.data?.self?.isHost || state.data.phase !== 'lobby') throw new Error('선생님(방장)이 대기실에서 올려 주세요.');
    state.questionUploadStatus = `${questions.length}개 문제를 적용하고 있어요…`;
    refreshTeacherSettings();
    send({ type: 'uploadQuestions', fileName: file.name, questions });
  } catch (error) {
    state.uploadingQuestions = false;
    state.questionUploadError = true;
    state.questionUploadStatus = error.message;
    refreshTeacherSettings();
  }
}

function clearCsvQuestions() {
  if (state.uploadingQuestions) return;
  state.uploadingQuestions = true;
  state.questionUploadError = false;
  state.questionUploadStatus = '기본 문제로 변경하고 있어요…';
  refreshTeacherSettings();
  send({ type: 'clearQuestions' });
}

function refreshTeacherSettings() {
  const root = document.querySelector('#teacher-settings-root');
  if (!root) return;
  root.innerHTML = renderTeacherSettings(state.data);
  bindTeacherSettings(root);
  const startButton = document.querySelector('#start-button');
  if (startButton) startButton.disabled = state.uploadingQuestions;
  const waitingButton = document.querySelector('#start-waiting-button');
  if (waitingButton) waitingButton.disabled = state.uploadingQuestions;
  const aiButton = document.querySelector('#start-ai-button');
  if (aiButton) aiButton.disabled = state.uploadingQuestions || state.data?.players?.length !== 1;
}

function bindTeacherSettings(root) {
  root.querySelectorAll('input[name="host-participation"]').forEach((input) => {
    input.addEventListener('change', () => send({ type: 'setHostParticipation', participation: input.value }));
  });
  root.querySelector('#upload-csv-button')?.addEventListener('click', () => root.querySelector('#question-csv-file')?.click());
  root.querySelector('#question-csv-file')?.addEventListener('change', (event) => uploadCsvQuestions(event.target.files?.[0]));
  root.querySelector('#clear-csv-button')?.addEventListener('click', clearCsvQuestions);
}

function submitRelay() {
  const prompt = state.data?.prompt;
  if (state.wrongAnswer || prompt?.kind !== 'relay' || prompt.submitted) return;
  const answer = document.querySelector('#answer-input')?.value ?? state.draft;
  if (!answer.trim()) return;
  send({ type: 'relayAnswer', answer, deadline: prompt.relayDeadline });
}

function sendRoundDraft(text, boundPrompt, boundPhase, boundRoundIndex) {
  const data = state.data;
  const prompt = data?.prompt;
  if (data?.phase !== 'round' || boundPhase !== 'round' || data.roundIndex !== boundRoundIndex || prompt?.kind !== boundPrompt?.kind) return;
  if (prompt.kind === 'word' || prompt.kind === 'repair') {
    if (prompt.id !== boundPrompt.id) return;
    send({ type: 'draft', promptId: prompt.id, text });
  } else if (prompt.kind === 'relay' && !prompt.submitted) {
    if (prompt.relayDeadline !== boundPrompt.relayDeadline) return;
    send({ type: 'draft', deadline: prompt.relayDeadline, text });
  }
}

function getTimeLabel(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}초`;
}

function formatScore(value) {
  return Math.round(Number(value || 0)).toLocaleString('ko-KR');
}

function teamName(team) {
  return team === 'blue' ? '청팀' : '백팀';
}

function getCharacter(characterId) {
  return characterOptions.find((character) => character.id === characterId) || characterOptions[1];
}

function renderCharacterPicker() {
  return `
    <div class="character-picker" role="group" aria-label="내 캐릭터 선택">
      ${characterOptions.map((character) => `
        <button type="button" class="character-choice ${state.selectedCharacter === character.id ? 'is-selected' : ''}" data-character="${character.id}" aria-pressed="${state.selectedCharacter === character.id}">
          <span class="character-choice__art" aria-hidden="true">${character.emoji}</span>
          <span class="character-choice__copy"><strong>${character.name}</strong><small>${character.description}</small></span>
        </button>
      `).join('')}
    </div>
    <p class="selected-character-label"><span>선택한 친구</span> ${getCharacter(state.selectedCharacter).emoji} ${getCharacter(state.selectedCharacter).name}</p>
  `;
}

function createCharacters(team, count) {
  const safeCount = Math.max(0, Math.min(Number(count || 0), 24));
  const characters = Array.from({ length: safeCount }, (_, index) => `
    <span class="puller puller--${team} variant-${index % 4}" aria-label="${teamName(team)} 캐릭터 ${index + 1}">
      <span class="puller__head"><i></i><i></i></span>
      <span class="puller__body"></span>
      <span class="puller__hand"></span>
    </span>
  `).join('');
  return characters || '<span class="empty-team">아직 참가자가 없어요</span>';
}

function renderHeader() {
  return `
    <header class="app-header">
      <a class="brand-mark" href="/" aria-label="말모이 줄다리기 홈">
        <span class="brand-mark__seal">한</span>
        <span>
          <span class="brand-mark__title"><strong>말모이 줄다리기</strong><span class="brand-mark__version">ver.1.0.6</span></span>
          <small>한글날 기념 타자 대전</small>
        </span>
      </a>
      <nav class="brand-links" aria-label="문수네집 공식 링크">
        <span class="made-by">made by</span>
        <a href="https://moonsunezipbrand.vercel.app" target="_blank" rel="noreferrer" aria-label="문수네집 브랜드 사이트 새 창">문수네집</a>
        <a href="https://www.instagram.com/moonsune.zip/" target="_blank" rel="noreferrer" aria-label="문수네집 인스타그램 새 창">Instagram</a>
        <a href="https://moonsunezip.com" target="_blank" rel="noreferrer" aria-label="문수네집 공식 사이트 새 창">moonsune.zip</a>
      </nav>
    </header>
  `;
}

function renderRoomEntryControls() {
  if (state.roomId) {
    return `
      <div class="room-code-selected"><span>초대받은 방</span><strong>${escapeHtml(state.roomId)}</strong></div>
      <button id="join-button" class="primary-button">이 방에 입장하기 <span>→</span></button>
      <button id="clear-room-button" class="text-button" type="button">다른 방 코드로 입장하기</button>
    `;
  }

  return `
    <fieldset class="play-mode-picker">
      <legend>방 모드</legend>
      <label class="play-mode-option"><input type="radio" name="play-mode" value="typing" ${state.selectedPlayMode === 'typing' ? 'checked' : ''} /><span><strong>기존 타자 모드</strong><small>타자 실력으로 팀 배정 · 타자와 퀴즈 4종목</small></span></label>
      <label class="play-mode-option"><input type="radio" name="play-mode" value="tablet" ${state.selectedPlayMode === 'tablet' ? 'checked' : ''} /><span><strong>태블릿 객관식 모드</strong><small>키보드 없이 터치로만 경기 · 모든 문제 보기 4개</small></span></label>
      <p>객관식 정답 60점 + 빠른 정답 보너스 최대 40점 · 오답 −30점</p>
    </fieldset>
    <button id="create-room-button" class="primary-button">방 만들기 <span>＋</span></button>
    <div class="room-divider"><span>또는</span></div>
    <div class="room-code-entry">
      <input id="room-code" class="text-input" maxlength="6" autocomplete="off" spellcheck="false" placeholder="방 코드 6자리" aria-label="방 코드" />
      <button id="room-code-button" class="secondary-button" type="button">입장</button>
    </div>
    <p class="room-entry-help">방을 만든 뒤 나타나는 QR 코드를 친구에게 보여 주세요.</p>
  `;
}

function renderRoomShare() {
  if (!state.roomId) return '';
  const shareUrl = getRoomShareUrl();
  return `
    <div class="room-share panel-card">
      <div class="room-share-copy">
        <div class="section-kicker">INVITE FRIENDS</div>
        <h2>QR 코드로 친구를 초대하세요</h2>
        <p class="muted">친구가 이 QR을 스캔하면 같은 방으로 바로 들어와요.</p>
        <div class="room-code-display"><span>방 코드</span><strong>${escapeHtml(state.roomId)}</strong></div>
        <div class="room-link-row">
          <input class="text-input" value="${escapeHtml(shareUrl)}" readonly aria-label="방 초대 링크" />
          <button id="copy-room-button" class="secondary-button" type="button">링크 복사</button>
        </div>
        <p class="room-link-note">휴대폰에서 스캔할 때는 같은 네트워크의 접속 주소를 사용하세요.</p>
      </div>
      <div class="room-qr-box">
        <img id="room-qr" alt="방에 입장하는 QR 코드" />
        <span>카메라로 스캔</span>
      </div>
    </div>
  `;
}

function renderTeacherSettings(data) {
  if (!data?.self?.isHost || data.phase !== 'lobby') return '';
  const uploaded = data.questionSet?.count > 0;
  return `<details class="teacher-settings panel-card" open>
    <summary>⚙ 선생님 설정</summary>
    <div class="teacher-settings-content">
      <fieldset class="teacher-participation"><legend>선생님 경기 참가</legend>
        <div class="teacher-participation-options">${HOST_PARTICIPATION_OPTIONS.map((option) => `<label><input type="radio" name="host-participation" value="${option.value}" ${data.hostParticipation === option.value ? 'checked' : ''} /><span>${option.label}</span></label>`).join('')}</div>
        <p>게임 시작 전에 선택해 주세요. 진행만 하는 선생님은 팀 인원·타자 테스트·점수에 포함되지 않으며, 경기 중 전체 참가자의 점수 배율을 조정할 수 있어요.</p>
      </fieldset>
      <h2>우리 반 객관식 문제</h2>
      <p>CSV 파일로 문제를 넣어요. ${data.playMode === 'tablet' ? '모든 라운드에서 업로드한 문제만 출제해요.' : '객관식 라운드에서 업로드한 문제만 출제해요.'}</p>
      <div class="question-set-status">${uploaded ? `<strong>선생님 문제 ${data.questionSet.count}개 적용 중</strong><span>${escapeHtml(data.questionSet.fileName)}</span>` : '<strong>기본 문제 사용 중</strong><span>파일을 올리면 기본 객관식 문제를 대신해요.</span>'}</div>
      <div class="teacher-settings-actions">
        <button type="button" id="upload-csv-button" class="secondary-button" ${state.uploadingQuestions ? 'disabled' : ''}>CSV 문제 업로드</button>
        <a class="secondary-button" href="/templates/malmoe-quiz-example.csv" download="말모이-객관식-예시양식.csv">예시 양식 다운로드</a>
        ${uploaded ? `<button type="button" id="clear-csv-button" class="secondary-button" ${state.uploadingQuestions ? 'disabled' : ''}>기본 문제로 되돌리기</button>` : ''}
      </div>
      <input id="question-csv-file" type="file" accept=".csv,text/csv" hidden />
      <p class="csv-format-help">열 이름: 문제, 보기1, 보기2, 보기3, 보기4, 정답, 해설, 분류<br />정답은 1~4 번호 또는 보기 문구로 적어요. 해설·분류는 비워도 돼요.<br />최대 ${MAX_CUSTOM_QUESTIONS}문제 · 256KB · Excel에서 CSV UTF-8로 저장해 주세요.</p>
      <p class="csv-retention-note">이 방에서만 사용하며 새 게임에도 유지돼요. 방이 사라지면 문제도 사라지니 원본 CSV를 보관해 주세요.</p>
      ${state.questionUploadStatus ? `<p class="csv-upload-message ${state.questionUploadError ? 'is-error' : ''}" role="${state.questionUploadError ? 'alert' : 'status'}">${escapeHtml(state.questionUploadStatus)}</p>` : ''}
    </div>
  </details>`;
}

function renderSoloLaunch(data) {
  if (!data?.self?.isHost) return '';
  const alone = data.players?.length === 1;
  return `<section class="solo-launch panel-card" aria-label="선생님 혼자 시작하기">
    <div><div class="section-kicker">SOLO PLAY</div><h2>학생들이 오기 전에도 시작해요</h2><p>대기 모드로 문제를 살펴보거나, AI와 1:1로 겨뤄 보세요.</p></div>
    <div class="solo-launch-grid">
      <article><h3>게임 시작 대기 모드</h3><p>QR을 띄워 학생 입장을 받으면서 1~4라운드를 혼자 연습해요.</p><button type="button" id="start-waiting-button" class="secondary-button" ${state.uploadingQuestions ? 'disabled' : ''}>대기 모드 시작</button></article>
      <article><h3>AI와 붙기 · 1:1</h3><p>선생님은 청팀, AI는 백팀! 높은 단계일수록 더 빠르고 정확하게 답해요.</p><label for="ai-level-select" class="field-label">AI 난이도 · 10단계</label><select id="ai-level-select" class="text-input">${AI_LEVELS.map((entry) => `<option value="${entry.level}" ${entry.level === state.selectedAiLevel ? 'selected' : ''}>${entry.level}단계 · ${entry.label}</option>`).join('')}</select><button type="button" id="start-ai-button" class="primary-button compact" ${!alone || state.uploadingQuestions ? 'disabled' : ''}>AI와 붙기</button>${!alone ? '<small>AI 1:1은 방에 혼자 있을 때 시작할 수 있어요.</small>' : ''}</article>
    </div>
  </section>`;
}

function renderWaitingControls(data) {
  const guests = data.players.filter((entry) => !entry.isHost && !entry.isAI);
  const classCount = guests.length + (data.hostParticipation === 'observe' ? 0 : 1);
  return `<section class="waiting-controls panel-card" aria-label="입장 대기와 라운드 연습">
    <div><div class="section-kicker">WAIT & PRACTICE · 학생 입장 대기</div><h2>혼자 연습하며 학생들을 기다려요</h2><p><b>학생 ${guests.length}명 입장</b> · 연습 점수는 본 경기에 이어지지 않아요.</p><div class="solo-actions"><button id="start-button" type="button" class="primary-button compact" ${classCount < 2 ? 'disabled' : ''}>학급 경기 시작 →</button><button id="return-lobby-button" type="button" class="secondary-button">설정으로 돌아가기</button></div>
      <div class="waiting-round-nav" role="group" aria-label="연습할 라운드 선택">${data.roundModes.map((mode, index) => `<button type="button" class="secondary-button" data-waiting-round="${index}" aria-pressed="${index === data.roundIndex}">${index + 1}R ${escapeHtml(mode.name)}</button>`).join('')}</div>
    </div><div class="waiting-qr"><img id="room-qr" alt="학생 입장용 QR 코드" /><strong>${escapeHtml(data.roomId)}</strong><button id="copy-room-button" type="button" class="secondary-button">링크 복사</button></div>
  </section>`;
}

function renderWaitingGuest(data) {
  return `<section class="lobby-room"><div class="lobby-title-row"><div><div class="section-kicker">WAITING ROOM</div><h1>입장했어요! 선생님을 기다려 주세요</h1><p>선생님이 문제를 연습하는 동안 학생들은 여기서 기다려요. 학급 경기가 시작되면 팀을 나눠 함께 경기합니다.</p></div><span class="waiting-pill"><i></i> 입장 완료</span></div>${renderRoomShare()}<section class="panel-card observer-card"><h2>함께 기다리는 친구들</h2><div class="player-chips">${data.players.filter((entry) => !entry.isAI).map((entry) => `<span class="player-chip">${escapeHtml(entry.name)}${entry.isHost ? '<small>선생님</small>' : ''}</span>`).join('')}</div></section></section>`;
}

function renderLobby() {
  const data = state.data;
  if (!state.connected) {
    return `<section class="lobby-card connection-card"><span class="loader"></span><p>서버에 연결하고 있어요…</p></section>`;
  }

  if (!state.joined) {
    return `
      <section class="lobby-layout">
        <div class="hero-card">
          <figure class="hero-preview"><video id="hero-preview-video" autoplay muted loop playsinline controls preload="metadata" poster="/videos/tug-preview-poster.jpg" aria-label="말모이 줄다리기 실제 경기 영상"><source src="/videos/tug-preview.mp4" type="video/mp4" />줄다리기 경기 영상입니다.</video><figcaption>우리말 문제를 풀수록 우리 팀이 줄을 당겨요.</figcaption></figure>
          <div class="eyebrow">HANGUL DAY · REALTIME GAME</div>
          <h1>우리말을 치고,<br /><em>줄을 당겨요.</em></h1>
          <p>순우리말의 뜻을 만나고, 바른 문장을 완성하며 청팀과 백팀이 한글의 힘으로 겨뤄요.</p>
          <div class="hero-stamps"><span>정확도</span><span>속도</span><span>팀워크</span></div>
        </div>
        <div class="join-card panel-card">
          <div class="section-kicker">${state.roomId ? '방 입장' : '방 만들기'}</div>
          <h2>${state.roomId ? '초대받은 방에 들어가요' : '방을 만들고 친구를 불러요'}</h2>
          <p class="muted">닉네임과 캐릭터를 고르고 입장해요. 방을 만들 때 타자 모드 또는 태블릿 객관식 모드를 선택할 수 있어요. 한 방에 최대 30명까지 함께할 수 있어요.</p>
          <label class="field-label" for="nickname">닉네임</label>
          <input id="nickname" class="text-input" maxlength="18" autocomplete="nickname" placeholder="예: 한별" value="${escapeHtml(state.nickname)}" />
          <div class="field-label character-field-label">내 캐릭터 <span>하나를 골라 주세요</span></div>
          ${renderCharacterPicker()}
          ${renderRoomEntryControls()}
          <div class="rules-mini"><span>01</span><p>타자로 입력하거나 태블릿에서 정답 보기를 터치해요.</p></div>
          <div class="rules-mini"><span>02</span><p>점수가 팀의 줄을 움직여요.</p></div>
          <div class="rules-mini"><span>03</span><p>각 라운드 3분! 4라운드 뒤 2:2면 돌림판 결승을 진행해요.</p></div>
        </div>
      </section>
    `;
  }

  const players = data?.players || [];
  const isHost = data?.self?.isHost;

  return `
    <section class="lobby-room">
      <div class="lobby-title-row">
        <div>
          <div class="section-kicker">WAITING ROOM</div>
          <h1>모두 모이면 시작해요</h1>
          <p class="muted">입장 ${players.length}/${data?.maxPlayers || 30}명 · 경기 참가 ${players.filter((player) => !player.spectator).length}명${players.some((player) => player.spectator) ? ' · 선생님은 진행만 해요' : ''}<br />${data?.playMode === 'tablet' ? '태블릿 객관식 모드 · 터치로만 경기하고 팀은 무작위로 나눠요.' : '기존 타자 모드 · 자유 연습 뒤 타자 실력을 재서 팀을 나눠요.'}</p>
        </div>
        ${isHost ? `<button id="start-button" class="primary-button compact" ${state.uploadingQuestions ? 'disabled' : ''}>게임 시작 <span>→</span></button>` : '<span class="waiting-pill"><i></i> 진행자를 기다리는 중</span>'}
      </div>
      <div id="teacher-settings-root">${renderTeacherSettings(data)}</div>
      ${renderSoloLaunch(data)}
      ${renderRoomShare()}
      <div id="practice-root">${renderPracticeCard(data)}</div>
      <article class="team-lobby-card lobby-roster">
        <div class="team-card-top"><span class="team-badge">모</span><span>참가자</span><strong>${players.length}명</strong></div>
        <div class="player-chips">${players.map((player) => {
          const character = getCharacter(player.characterId);
          const isSelf = player.id === data?.self?.id;
          return `<span class="player-chip ${isSelf ? 'is-self' : ''}"><span aria-hidden="true">${character.emoji}</span>${escapeHtml(player.name)}${isSelf ? '<small>나</small>' : ''}${player.isHost ? `<small>${player.spectator ? '진행만' : '진행·참가'}</small>` : ''}</span>`;
        }).join('') || '<span class="muted">참가자를 기다리는 중</span>'}</div>
      </article>
      <div class="how-to panel-card">
        <div><span class="how-icon">✦</span><strong>게임 규칙</strong></div>
        <p>${data?.playMode === 'tablet' ? '<b>타자 테스트 없이 모든 라운드를 터치 객관식으로 진행해요.</b> 보기 4개 중 한 번만 선택하세요. 기본 정답은 60점에 속도 보너스 최대 40점, 기본 오답 감점은 30점이에요. 선생님이 경기 중 설정한 배율을 곱하고, 정답에는 라운드·인원 보정도 적용돼요. 오답 해설은 3초 동안 보여 줘요.' : '위 연습은 점수에 반영되지 않아요. 방장이 시작하면 <b>30초 동안 문장을 입력해 타자 실력을 재고</b>, 팀을 자동으로 나눈 뒤 1라운드를 시작해요. 인원이 적은 팀에는 인원수 비율만큼 보정 점수가 적용돼요.'}</p>
      </div>
    </section>
  `;
}

function renderPlacement(data) {
  if (data.self?.spectator) {
    return `<section class="game-page placement-page"><div class="game-heading"><div><div class="section-kicker">TEACHER · 진행자 화면</div><h1>아이들의 타자 실력을 재고 있어요</h1><p>선생님은 경기와 팀 배정에 참가하지 않아요. 테스트가 끝나면 경기 화면으로 이동해요.</p></div><div class="placement-timer" role="timer"><small>남은 시간</small><strong id="placement-time">${getTimeLabel(data.placementRemainingMs)}</strong></div></div><div id="prompt-root">${renderObserverCard()}</div></section>`;
  }
  const seconds = Math.round(Number(data.placementDurationMs || 30_000) / 1000);
  return `
    <section class="game-page placement-page">
      <div class="game-heading"><div><div class="section-kicker">TEAM PLACEMENT · 팀 나누기 전</div><h1>타자 실력 재기</h1><p>${seconds}초 동안 문장을 정확하게 입력하세요. 실력이 비슷하도록 팀을 나눠 드려요.</p></div><div class="placement-timer" role="timer"><small>남은 시간</small><strong id="placement-time">${getTimeLabel(data.placementRemainingMs)}</strong></div></div>
      <div id="prompt-root">${renderPlacementCard(data)}</div>
    </section>
  `;
}

function renderPlacementCard(data) {
  if (data.self?.spectator) return renderObserverCard();
  return `
    <section class="prompt-card prompt-card--placement">
      <div class="prompt-meta"><span class="round-badge">PRACTICE</span><span class="prompt-help">문장을 그대로 입력하면 다음 문장으로 넘어가요</span></div>
      <div class="relay-sentence placement-sentence">${escapeHtml(data.prompt?.sentence || '문장을 준비하고 있어요…')}</div>
      <form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="여기에 문장을 입력하세요" /><button class="submit-button">입력 <span>↵</span></button></form>
      <p class="prompt-note">맞게 친 글자만 세어요 · 지금까지 <b id="placement-keystrokes">${formatScore(data.self?.placementKeystrokes)}</b>타</p>
    </section>
  `;
}

function renderPracticeCard(data) {
  if (data.self?.spectator) return renderObserverCard();
  if (data?.playMode === 'tablet') {
    return `<section class="practice-card panel-card"><div class="section-kicker">TABLET QUIZ · 터치로만 경기</div><h2>보기 4개 중 정답을 터치해요</h2><p class="muted">빠른 정답은 보너스! 기본 오답 감점은 30점이며 경기 중 선생님이 설정한 배율을 곱해요.</p><div class="round-strip">${(data.roundModes || []).map((mode, index) => `<span class="round-chip"><b>${index + 1}</b>${escapeHtml(mode.name)}</span>`).join('')}</div></section>`;
  }
  const prompt = data?.prompt;
  if (!prompt?.word) {
    return '<section class="practice-card panel-card"><p class="muted">연습 낱말을 준비하고 있어요…</p></section>';
  }
  return `
    <section class="practice-card panel-card">
      <div class="practice-card__head">
        <div>
          <div class="section-kicker">OPEN PRACTICE · 자유 연습</div>
          <h2>선생님이 시작하기 전, 우리말을 연습해요</h2>
          <p class="muted">뜻을 살펴보고 낱말을 입력해 보세요. 연습 기록은 실력 판정과 팀 점수에 반영되지 않아요.</p>
        </div>
        <span class="practice-count">연습 ${formatScore(data.self?.practiceCount)}회</span>
      </div>
      <div class="practice-target">
        <div class="prompt-meta"><span class="round-badge">우리말 연습</span><span class="category-badge">${escapeHtml(prompt.category || '순우리말')}</span></div>
        <strong>${escapeHtml(prompt.word)}</strong>
        <p>${escapeHtml(prompt.meaning || '')}</p>
        ${prompt.example ? `<small>예문 · ${escapeHtml(prompt.example)}</small>` : ''}
      </div>
      <form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="낱말을 그대로 입력해 보세요" /><button class="submit-button">연습 입력 <span>↵</span></button></form>
      <p class="prompt-note">정확히 입력하면 다음 순우리말로 넘어가요.</p>
    </section>
  `;
}

function renderPromptOnly() {
  const data = state.data;
  const root = document.querySelector(data?.phase === 'lobby' ? '#practice-root' : '#prompt-root');
  if (!root || !data) {
    render();
    return;
  }
  root.innerHTML = data.phase === 'lobby'
    ? renderPracticeCard(data)
    : data.phase === 'placement' ? renderPlacementCard(data) : renderPrompt(data);
  const input = root.querySelector('#answer-input');
  if (input) input.value = state.draft;
  bindPromptEvents(root);
  updateDynamic();
}

function renderTeamReveal(data) {
  const self = data.self;
  const myTeam = self?.spectator ? null : self?.team || 'blue';
  const roster = (team) => (data.players || []).filter((player) => player.team === team).map((player) => {
    const character = getCharacter(player.characterId);
    return `<span class="player-chip ${player.id === self?.id ? 'is-self' : ''}"><span aria-hidden="true">${character.emoji}</span>${escapeHtml(player.name)}${player.id === self?.id ? '<small>나</small>' : ''}</span>`;
  }).join('');
  return `
    <section class="game-page team-reveal-page">
      <section class="team-reveal-card team-reveal-card--${myTeam || 'observer'}">
        <div class="section-kicker">${myTeam ? 'MY TEAM' : 'TEACHER · 진행자 화면'}</div>
        <div class="team-reveal-seal" aria-hidden="true">${myTeam ? myTeam === 'blue' ? '청' : '백' : '진행'}</div>
        <h1>${myTeam ? `${escapeHtml(self?.name || '')}님은 <em>${teamName(myTeam)}</em>이에요!` : '선생님은 진행만 맡아요'}</h1>
        <p>${!myTeam ? '아이들의 팀 배정을 확인해 주세요. 경기 중 양 팀 모든 참가자의 점수 배율을 조정할 수 있어요.' : data.playMode === 'tablet' ? '인원수가 비슷하도록 팀을 나눴어요. 이제 터치로 정답을 골라요!' : `내 타자 속도 <b>분당 ${formatScore(self?.typingSpeed)}타</b> · 실력이 비슷하도록 팀을 나눴어요.`}</p>
        <div class="next-countdown">1라운드 시작까지 <span id="reveal-time">${getTimeLabel(data.teamRevealRemainingMs)}</span></div>
      </section>
      <div class="team-grid">
        ${['blue', 'white'].map((team) => `
          <article class="team-lobby-card team-lobby-card--${team} ${team === myTeam ? 'is-mine' : ''}">
            <div class="team-card-top"><span class="team-badge">${team === 'blue' ? '청' : '백'}</span><span>${teamName(team)}${team === myTeam ? ' · 우리 팀' : ''}</span><strong>${data.counts?.[team] || 0}명</strong></div>
            <div class="player-chips">${roster(team)}</div>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderScoreboard(data) {
  if (data.sessionMode === 'waiting') return `<div class="scoreboard waiting-scoreboard"><div class="score-card score-card--blue"><div class="score-card__label">나의 연습 점수</div><strong id="blue-score">${formatScore(data.scores.blue)}</strong><small>본 경기를 시작하면 새 점수로 경기해요.</small></div><div class="score-card score-card--white"><div class="score-card__label">현재 연습 종목</div><strong class="practice-round-number">${data.roundNumber}R</strong><small>${escapeHtml(data.mode?.name || '')}</small></div></div>`;
  const mine = (team) => (data.self?.team === team ? ' is-mine' : '');
  const mineTag = (team) => (data.self?.team === team ? '<span class="mine-tag">우리 팀</span>' : '');
  const scoringRule = (team) => getScoringRule(data, team);
  return `
    <div class="scoreboard">
      <div class="score-card score-card--blue${mine('blue')}">
        <div class="score-card__label"><span class="dot"></span> 청팀 <small id="blue-count">${data.counts.blue}명</small>${mineTag('blue')}</div>
        <strong id="blue-score">${formatScore(data.scores.blue)}</strong>
        <small class="multiplier" id="blue-multiplier">${scoringRule('blue')}</small><span class="round-wins" id="blue-wins">라운드 ${data.roundWins?.blue || 0}승</span>
      </div>
      <div class="score-vs">VS</div>
      <div class="score-card score-card--white${mine('white')}">
        <div class="score-card__label"><span class="dot"></span> 백팀 <small id="white-count">${data.counts.white}명</small>${mineTag('white')}</div>
        <strong id="white-score">${formatScore(data.scores.white)}</strong>
        <small class="multiplier" id="white-multiplier">${scoringRule('white')}</small><span class="round-wins" id="white-wins">라운드 ${data.roundWins?.white || 0}승</span>
      </div>
    </div>
  `;
}

function getScoringRule(data, team) {
  const multiplier = data.scoreMultiplier || 1;
  return data.mode?.id === 'relay'
    ? `대표 정답 ${2 * multiplier}칸 · 응원 정답 ${multiplier}점`
    : `전체 배율 ×${multiplier} · 인원 보정 ×${Number(data.multipliers?.[team] || 1).toFixed(2)}`;
}

function renderScoreSettings(data) {
  const multiplier = data.scoreMultiplier || 1;
  if (!data.self?.isHost || !SCORE_SETTING_PHASES.includes(data.phase)) {
    return `<div class="score-setting-summary">전체 참가자 점수 배율 <strong id="score-setting-value">×${multiplier}</strong></div>`;
  }
  return `<section class="score-settings panel-card" aria-label="전체 참가자 점수 배율 설정">
    <div class="score-settings-heading"><h2>전체 참가자 점수 배율</h2><strong id="score-setting-value" role="status">현재 ${multiplier}배</strong></div>
    <div class="score-levels" role="group" aria-label="점수 배율 7단계">${SCORE_MULTIPLIER_LEVELS.map((level) => `<button type="button" class="score-level" data-score-multiplier="${level}" aria-label="${level}배" aria-pressed="${level === multiplier}">×${level}</button>`).join('')}</div>
    <p>청팀·백팀 모든 참가자의 다음 득점·감점에 공통으로 적용해요. 배율이 클수록 줄이 크게 움직여 승부가 빨리 나요. 이미 얻은 점수는 유지돼요.</p>
  </section>`;
}

function renderArena(data) {
  const position = Math.round(data.ropePosition ?? 50);
  const ropeStep = getRopeStep(data);
  const maxSteps = getRopeMaxSteps(data);
  const bluePlayers = data.players?.filter((player) => player.team === 'blue') || [];
  const whitePlayers = data.players?.filter((player) => player.team === 'white') || [];
  const crowded = bluePlayers.length + whitePlayers.length > 8;
  const victoryTeam = winningTeamForCelebration(data);
  const fireworks = victoryTeam ? Array.from({ length: 4 }, (_, burst) => `<span class="firework firework--${burst}" aria-hidden="true">${Array.from({ length: 12 }, (_, ray) => `<i style="--ray:${ray}"></i>`).join('')}</span>`).join('') : '';
  return `
    <section class="arena-card">
      <div class="arena-topline"><span><b>세종대왕님</b>이 공정하게 심판해요 <em class="overtime-badge" id="overtime-badge" ${data.overtimeCount ? '' : 'hidden'}>연장전 ${data.overtimeCount}</em></span></div>
      <div class="three-arena" id="three-arena" data-rope-position="${position}" aria-label="청팀과 백팀 캐릭터가 줄다리기하는 3차원 경기장">
        <button type="button" class="bgm-toggle" id="bgm-toggle" aria-pressed="${state.soundEnabled}">🥁 BGM ${state.soundEnabled ? '끄기' : '켜기'}</button>
        <div class="scene-overlay">
          <span class="scene-team-tag scene-team-tag--blue" aria-hidden="true">청팀 · ${data.counts.blue}명</span>
          <div class="scene-judge-stack">
            <div class="arena-time" role="timer"><small>${data.phase === 'round' ? `${data.roundNumber}라운드 남은 시간` : data.phase === 'roundIntro' ? '라운드 시작까지' : data.phase === 'intermission' ? '다음 라운드까지' : data.phase === 'wheel' ? '결승 준비' : '경기 종료'}</small><strong id="arena-time">${data.phase === 'round' ? getTimeLabel(data.timeRemainingMs) : data.phase === 'roundIntro' ? getTimeLabel(data.roundIntroRemainingMs) : data.phase === 'intermission' ? getTimeLabel(data.intermissionRemainingMs) : data.phase === 'wheel' ? getTimeLabel(data.wheelRemainingMs) : '완료'}</strong></div>
            <div class="scene-judge-copy" aria-hidden="true"><strong>한글 사랑해요</strong><small>세종대왕님 감사해요</small></div>
          </div>
          <span class="scene-team-tag scene-team-tag--white" aria-hidden="true">백팀 · ${data.counts.white}명</span>
        </div>
        ${data.phase === 'roundIntro' ? `<div class="round-intro-overlay" role="status"><span>${data.roundNumber === 5 ? '결승' : `${data.roundNumber}라운드`} 시작 안내</span><h2>${escapeHtml(data.mode?.name || '')}</h2><p>${escapeHtml(getRoundGuide(data.mode))}</p><strong><span class="intro-time">${getTimeLabel(data.roundIntroRemainingMs)}</span> 뒤 시작!</strong></div>` : ''}
        ${victoryTeam ? `<div class="victory-celebration victory-celebration--${victoryTeam}" role="status">${fireworks}<strong>${teamName(victoryTeam)} 승리! 🎉</strong></div>` : ''}
        <div class="scene-step-track" aria-hidden="true"><b>청</b>${Array.from({ length: maxSteps * 2 + 1 }, (_, index) => `<i class="rope-step ${index === maxSteps ? 'is-center' : ''} ${index === maxSteps + ropeStep ? 'is-current' : ''}" data-rope-tick="${index}"></i>`).join('')}<b>백</b></div>
        <div class="scene-position-label" aria-live="polite">${getRopeStepLabel(data)}</div>
      </div>
      <div class="scene-accessibility"><strong>경기장 안내</strong> ${crowded ? `청팀 ${bluePlayers.length}명 · 백팀 ${whitePlayers.length}명 참가 중` : `청팀 ${bluePlayers.map((player) => `${getCharacter(player.characterId).name} ${player.name}`).join(', ') || '참가자 없음'} · 백팀 ${whitePlayers.map((player) => `${getCharacter(player.characterId).name} ${player.name}`).join(', ') || '참가자 없음'}`}</div>
    </section>
  `;
}

function getRopeMaxSteps(data) {
  return Math.max(1, Number(data.ropeMaxSteps) || 20);
}

function getRopeStep(data) {
  const maxSteps = getRopeMaxSteps(data);
  const inferred = Math.round(((Number(data.ropePosition ?? 50) - 50) / 43) * maxSteps);
  return Math.max(-maxSteps, Math.min(maxSteps, Number(data.ropeStep ?? inferred)));
}

function getRopeStepLabel(data) {
  const step = getRopeStep(data);
  const maxSteps = getRopeMaxSteps(data);
  return step === 0 ? `줄 위치 중앙 · 0/${maxSteps}칸` : `줄 위치 ${step < 0 ? '청팀' : '백팀'} 방향 ${Math.abs(step)}/${maxSteps}칸`;
}

async function toggleBgm() {
  if (state.soundEnabled) {
    stopBgm();
    state.soundEnabled = false;
  } else {
    const started = await startBgm();
    if (!started) {
      showNotice('이 브라우저에서는 BGM을 재생할 수 없어요.');
      return;
    }
    state.soundEnabled = true;
  }
  const button = document.querySelector('#bgm-toggle');
  if (button) {
    button.textContent = `🥁 BGM ${state.soundEnabled ? '끄기' : '켜기'}`;
    button.setAttribute('aria-pressed', String(state.soundEnabled));
  }
}

function renderPrompt(data) {
  if (data.phase === 'roundIntro') {
    return `<section class="prompt-card round-intro-card"><span class="round-badge">${data.roundNumber === 5 ? 'FINAL ROUND' : `ROUND ${data.roundNumber}`}</span><h2>${escapeHtml(data.mode?.name || '')}</h2><p>${escapeHtml(getRoundGuide(data.mode))}</p><div class="next-countdown"><span class="intro-time">${getTimeLabel(data.roundIntroRemainingMs)}</span> 뒤 시작해요!</div>${renderAdvanceRoundButton(data)}</section>`;
  }
  if (data.phase === 'wheel') {
    const selected = Number(data.wheelSelectedIndex ?? 0);
    return `<section class="prompt-card wheel-card" style="--wheel-turns:${1440 - selected * 90}deg;--wheel-duration:${Math.round(Number(data.wheelDurationMs || 7000) * .65)}ms"><span class="round-badge">FINAL ROUND</span><h2>2:2 동점! 결승 종목 돌림판</h2><p>1~4라운드 중 하나를 다시 겨뤄 최종 승자를 정해요.</p><div class="wheel-wrap"><div class="wheel-pointer" aria-hidden="true"></div><div class="game-wheel">${data.questionSet?.count && data.playMode === 'tablet' ? '<span>퀴즈 1</span><span>퀴즈 2</span><span>퀴즈 3</span><span>퀴즈 4</span>' : data.playMode === 'tablet' ? '<span>순우리말</span><span>창제 원리</span><span>세종대왕</span><span>종합 퀴즈</span>' : '<span>말모이</span><span>뜻풀이</span><span>바른말</span><span>릴레이</span>'}</div></div><p class="wheel-countdown">결승까지 <span id="wheel-time">${getTimeLabel(data.wheelRemainingMs)}</span></p><p class="wheel-result">선정 종목: <strong>${escapeHtml(data.roundModes?.[selected]?.name || modeLabels[roundModes[selected]?.id] || '')}</strong></p></section>`;
  }

  if (data.phase === 'intermission') {
    const lastRound = data.roundScores?.at(-1);
    const waiting = data.sessionMode === 'waiting';
    const nextIndex = waiting ? (data.roundIndex + 1) % 4 : data.roundIndex + 1;
    const nextMode = data.roundModes?.[nextIndex];
    return `<section class="prompt-card intermission-card"><span class="round-badge">ROUND ${data.roundNumber} ${waiting ? 'PRACTICE' : 'RESULT'}</span><h2>${waiting ? `${data.roundNumber}라운드 연습 완료!` : `${teamName(lastRound?.winner)} 라운드 승리!`}</h2><p>${escapeHtml(data.notice || '')}</p><div class="round-result-score">${waiting ? `연습 ${formatScore(lastRound?.blue)}점` : `청 ${formatScore(lastRound?.blue)} : ${formatScore(lastRound?.white)} 백`}</div><div class="next-round-guide"><span class="round-badge">다음 ${nextIndex + 1}라운드 안내</span><h3>${escapeHtml(nextMode?.name || '')}</h3><p>${escapeHtml(getRoundGuide(nextMode))}</p></div><div class="next-countdown">다음 라운드 시작까지 <span id="intermission-time">${getTimeLabel(data.intermissionRemainingMs)}</span></div>${renderAdvanceRoundButton(data)}</section>`;
  }

  if (data.phase === 'results') {
    if (data.sessionMode === 'ai') return `<section class="prompt-card result-card"><span class="round-badge">AI ${data.aiLevel}단계 · 1:1 RESULT</span><h2>${data.winner === data.self.team ? 'AI와의 경기에서 이겼어요!' : 'AI가 이번 경기에서 이겼어요!'}</h2><p>라운드 승수 나 ${data.roundWins.blue} : ${data.roundWins.white} AI</p><div class="solo-actions"><button data-ai-retry="${data.aiLevel}" class="primary-button compact">같은 단계 다시 도전</button>${data.aiLevel < 10 ? `<button data-ai-retry="${data.aiLevel + 1}" class="secondary-button">다음 단계 AI와 붙기</button>` : ''}<button id="restart-button" class="secondary-button">학급 대기실로 돌아가기</button></div></section>`;
    return `<section class="prompt-card result-card"><span class="round-badge">GAME RESULT</span><h2>${teamName(data.winner)} 최종 승리!</h2><p>라운드 승수 청팀 ${data.roundWins?.blue || 0} : ${data.roundWins?.white || 0} 백팀</p><div class="round-results">${(data.roundScores || []).map((round) => `<span>${round.round}R ${escapeHtml(round.mode)} · <b>${teamName(round.winner)} 승</b></span>`).join('')}</div><div class="result-stars">✦ ✦ ✦</div><button id="restart-button" class="primary-button">새 게임 준비하기 <span>↗</span></button></section>`;
  }

  if (data.self?.spectator) return renderObserverCard();
  if (!data.prompt) return `<section class="prompt-card"><p class="muted">다음 문제를 준비하고 있어요.</p></section>`;

  const prompt = data.prompt;
  if (prompt.kind === 'word') {
    return `
      <section class="prompt-card prompt-card--word">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="category-badge">${escapeHtml(prompt.category || '순우리말')}</span><span class="prompt-help">순우리말을 정확하게 입력하세요</span></div>
        <h2>${escapeHtml(prompt.word)}</h2>
        <form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="여기에 입력해 주세요" /><button class="submit-button">당기기 <span>↗</span></button></form>
        <p class="prompt-note">정답을 입력하면 뜻과 예문을 바로 만나요.</p>
      </section>
    `;
  }

  if (prompt.kind === 'quiz') {
    return `
      <section class="prompt-card prompt-card--quiz">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="category-badge ${prompt.category === '순우리말' ? '' : 'category-badge--history'}">${escapeHtml(prompt.category || '뜻풀이')}</span><span class="prompt-help">${prompt.source === 'custom' ? '선생님 문제 · 보기 4개 중 정답을 골라 주세요' : prompt.category === '순우리말' ? '이 뜻에 맞는 순우리말을 골라 주세요' : '한글 창제 원리와 세종대왕의 기록을 떠올려 골라 주세요'}</span></div>
        ${prompt.source !== 'custom' && prompt.category !== '순우리말' ? '<div class="history-ribbon">한글과 세종대왕 배움 카드</div>' : ''}
        <div class="meaning-question">${escapeHtml(prompt.meaning)}</div>
        <div class="choice-grid">${prompt.choices.map((choice, index) => `<button class="choice-button" data-choice="${escapeHtml(choice)}"><span>${String.fromCharCode(9312 + index)}</span>${escapeHtml(choice)}</button>`).join('')}</div>
        <p class="prompt-note">기본 정답 60점 + 속도 보너스 최대 40점 · 기본 오답 −30점<br />기본 점수·감점에 선생님이 설정한 배율을 곱해요. 8초 안에 빠르게 맞힐수록 보너스가 커지고, 정답 점수에 라운드·인원 보정이 적용돼요.</p>
      </section>
    `;
  }

  if (prompt.kind === 'repair') {
    return `
      <section class="prompt-card prompt-card--repair">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="category-badge">띄어쓰기</span><span class="prompt-help">띄어쓰기를 제대로 해서 바른 문장으로 고쳐 입력하세요</span></div>
        <div class="repair-question">${escapeHtml(prompt.question)}</div>
        <div class="spacing-rule">띄어쓰기를 정확하게 해야 정답으로 인정돼요.</div>
        <form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="띄어쓰기를 제대로 해서 입력하세요" /><button class="submit-button">수리 완료 <span>↗</span></button></form>
      </section>
    `;
  }

  if (prompt.kind === 'relay') {
    const selected = prompt.selected;
    const representativeName = (id) => (data.players || []).find((player) => player.id === id)?.name || '선정 중';
    return `
      <section class="prompt-card prompt-card--relay">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}${data.roundNumber === 5 ? ' FINAL' : ''}</span><span class="prompt-help">${selected ? '당신이 이번 팀 대표예요! 기본 정답은 줄 2칸 이동' : '대표를 응원하며 같은 문장을 입력하면 기본 1점'}</span></div>
        <div class="relay-versus"><span>청팀 대표 <strong>${escapeHtml(representativeName(data.relay?.blueId))}</strong></span><b>VS</b><span>백팀 대표 <strong>${escapeHtml(representativeName(data.relay?.whiteId))}</strong></span></div>
        <div class="relay-sentence">${escapeHtml(prompt.prompt)}</div>
        <p class="relay-scoring-note">기본 대표 정답: 줄 2칸 이동 · 기본 응원 정답: 1점 · 설정한 점수 배율을 곱해요. 제한시간까지 대표가 계속 바뀌어요.</p>
        ${prompt.submitted ? '<div class="spectator-message">입력 완료! 다음 문장을 기다려 주세요.</div>' : `<form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="문장을 똑같이 입력해 주세요" /><button class="submit-button">${selected ? '대표 출전' : '응원 보태기'} <span>↗</span></button></form>`}
      </section>
    `;
  }

  return '';
}

function renderObserverCard() {
  return `<section class="observer-card panel-card"><div class="section-kicker">TEACHER · 경기 미참가</div><h2>선생님은 진행 중이에요</h2><p>아이들의 경기를 지켜보고 전체 참가자 점수 배율을 조정해 주세요. 선생님은 팀 인원과 점수에 포함되지 않아요.</p></section>`;
}

function renderGameIdentity(data) {
  const self = data.self;
  if (!self) return '<div class="live-pill"><i></i> LIVE SERVER</div>';
  if (self.spectator) return `<div class="my-team-chip my-team-chip--observer"><span>진행</span><div><small>${escapeHtml(self.name)}</small><strong>선생님 · 경기 미참가</strong></div></div>`;
  return `<div class="my-team-chip my-team-chip--${self.team}"><span>${self.team === 'blue' ? '청' : '백'}</span><div><small>${self.isHost ? '선생님 · ' : ''}${escapeHtml(self.name)}</small><strong>나는 ${teamName(self.team)}</strong></div></div>`;
}

function renderGame() {
  const data = state.data;
  const finalRoundActive = data.roundIndex === 4 || data.phase === 'wheel';
  const finalRoundPending = !finalRoundActive && data.roundIndex < 4;
  return `
    <section class="game-page">
      ${data.sessionMode === 'waiting' ? renderWaitingControls(data) : data.sessionMode === 'ai' ? `<section class="ai-match-status panel-card"><div><div class="section-kicker">AI MATCH · 1:1</div><h2>AI ${data.aiLevel}단계 · ${escapeHtml(getAiLevel(data.aiLevel)?.label || '')}</h2><p>청팀은 나, 백팀은 AI예요. ${data.playMode === 'tablet' ? '보기 4개를 터치해' : '네 종목의 문제를 풀어'} 겨뤄 보세요.</p></div><button id="return-lobby-button" type="button" class="secondary-button">학급 대기실로 돌아가기</button></section>` : ''}
      <div class="game-heading"><div><div class="section-kicker">HANGUL DAY MATCH · ${data.roundNumber === 5 ? '결승 5라운드' : `${Math.max(1, data.roundNumber)}라운드`}</div><h1>${escapeHtml(data.mode?.name || '말모이 줄다리기')}</h1><p>${escapeHtml(data.mode?.description || '한글의 힘으로 줄을 당겨요.')}</p></div>${renderGameIdentity(data)}</div>
      ${renderScoreboard(data)}
      ${renderScoreSettings(data)}
      ${renderArena(data)}
      <div id="prompt-root">${renderPrompt(data)}</div>
      ${data.sessionMode === 'waiting' ? '' : `<div class="round-strip">${(data.roundModes || roundModes).map((mode, index) => `<span class="round-chip ${index === data.roundIndex ? 'is-active' : index < data.roundIndex ? 'is-done' : ''}"><b>${index + 1}</b>${escapeHtml(mode.name || modeLabels[mode.id])}${data.roundScores?.[index] ? ` · ${teamName(data.roundScores[index].winner)} 승` : ''}</span>`).join('')}<span class="round-chip round-chip--final ${finalRoundActive ? 'is-active' : ''} ${finalRoundPending ? 'is-optional' : ''}" title="1~4라운드가 2:2로 끝나면 열립니다"><b>5</b>돌림판 결승${finalRoundPending ? ' · 2:2일 때' : ''}</span></div>`}
    </section>
  `;
}

function render() {
  isComposing = false;
  pendingRender = null;
  pendingDraftReset = false;
  const data = state.data;
  const inRoomPhase = Boolean(data?.phase && state.joined && data.phase !== 'lobby');
  const waitingGuest = data?.sessionMode === 'waiting' && !data.self?.isHost;
  const isGame = inRoomPhase && !waitingGuest && !['placement', 'teamReveal'].includes(data.phase);
  if (tugScene) {
    tugScene.dispose();
    tugScene = null;
  }
  const page = waitingGuest ? renderWaitingGuest(data) : !inRoomPhase ? renderLobby()
    : data.phase === 'placement' ? renderPlacement(data)
      : data.phase === 'teamReveal' ? renderTeamReveal(data)
        : renderGame();
  app.innerHTML = `${renderHeader()}<main>${page}</main>${renderTeacherQr()}<div id="notice-root"></div><div id="toast-root"></div><div id="wrong-answer-root"></div>`;
  const input = document.querySelector('#answer-input');
  if (input) input.value = state.draft;
  bindEvents();
  renderRoomQr();
  updateDynamic();
  if (isGame) {
    const sceneHost = document.querySelector('#three-arena');
    if (sceneHost) {
      try {
        tugScene = mountTugScene(sceneHost, data, { selfId: data.self?.id, flashUntil: nameFlashUntil });
      } catch (error) {
        sceneHost.innerHTML = '<div class="scene-fallback">3D 경기장을 준비하는 중이에요. 잠시 후 다시 시도해 주세요.</div>';
        console.error(error);
      }
    }
  }
  if (state.notice) renderNotice();
  if (state.result) renderResultToast();
  renderWrongAnswer();
}

function bindEvents() {
  document.querySelector('#teacher-join-qr')?.addEventListener('click', showRoomQr);
  document.querySelectorAll('#room-qr').forEach((image) => {
    image.tabIndex = 0;
    image.setAttribute('role', 'button');
    image.setAttribute('aria-label', '학생 입장 QR 크게 보기');
    image.addEventListener('click', showRoomQr);
    image.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showRoomQr(); } });
  });
  document.querySelector('#ai-level-select')?.addEventListener('change', (event) => { state.selectedAiLevel = Number(event.target.value); });
  document.querySelector('#start-waiting-button')?.addEventListener('click', () => send({ type: 'startWaiting' }));
  document.querySelector('#start-ai-button')?.addEventListener('click', () => send({ type: 'startAI', level: Number(document.querySelector('#ai-level-select')?.value || 1) }));
  document.querySelector('#return-lobby-button')?.addEventListener('click', restartGame);
  document.querySelectorAll('[data-waiting-round]').forEach((button) => button.addEventListener('click', () => send({ type: 'selectWaitingRound', roundIndex: Number(button.dataset.waitingRound) })));
  const previewVideo = document.querySelector('#hero-preview-video');
  if (previewVideo && window.matchMedia('(prefers-reduced-motion: reduce)').matches) previewVideo.pause();
  document.querySelectorAll('[data-score-multiplier]').forEach((button) => {
    button.addEventListener('click', () => {
      if (!state.connected || !state.data?.self?.isHost) return;
      send({ type: 'setScoreMultiplier', multiplier: Number(button.dataset.scoreMultiplier) });
    });
  });
  const settingsRoot = document.querySelector('#teacher-settings-root');
  if (settingsRoot) bindTeacherSettings(settingsRoot);
  document.querySelectorAll('input[name="play-mode"]').forEach((input) => {
    input.addEventListener('change', () => { state.selectedPlayMode = input.value; });
  });
  document.querySelector('#bgm-toggle')?.addEventListener('click', toggleBgm);
  document.querySelector('#join-button')?.addEventListener('click', join);
  document.querySelector('#create-room-button')?.addEventListener('click', createRoom);
  document.querySelector('#room-code-button')?.addEventListener('click', joinByRoomCode);
  document.querySelector('#room-code')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinByRoomCode();
  });
  document.querySelector('#clear-room-button')?.addEventListener('click', clearRoom);
  document.querySelector('#copy-room-button')?.addEventListener('click', copyRoomLink);
  document.querySelector('#nickname')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });
  document.querySelector('#nickname')?.addEventListener('input', (event) => {
    state.nickname = event.target.value;
  });
  document.querySelector('#start-button')?.addEventListener('click', startGame);
  document.querySelectorAll('[data-character]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCharacter = button.dataset.character;
      render();
    });
  });
  bindPromptEvents(document);
}

function bindPromptEvents(root) {
  root.querySelectorAll('[data-ai-retry]').forEach((button) => button.addEventListener('click', () => send({ type: 'startAI', level: Number(button.dataset.aiRetry) })));
  const boundPrompt = state.data?.prompt;
  const boundPhase = state.data?.phase;
  const boundRoundIndex = state.data?.roundIndex;
  root.querySelector('#advance-round-button')?.addEventListener('click', (event) => {
    const current = state.data;
    if (!current?.self?.isHost || current.phase !== boundPhase || current.roundIndex !== boundRoundIndex) return;
    event.currentTarget.disabled = true;
    send({ type: 'advanceRound', phase: boundPhase, roundIndex: boundRoundIndex });
  });
  root.querySelector('#restart-button')?.addEventListener('click', restartGame);
  root.querySelector('#answer-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const current = state.data;
    if (current?.phase !== boundPhase || current?.roundIndex !== boundRoundIndex || current?.prompt?.kind !== boundPrompt?.kind) return;
    if (boundPrompt?.kind === 'relay' ? current.prompt.relayDeadline !== boundPrompt.relayDeadline : current.prompt?.id !== boundPrompt?.id) return;
    if (state.data?.prompt?.kind === 'relay') submitRelay();
    else submitAnswer();
  });
  root.querySelectorAll('[data-choice]').forEach((button) => {
    button.addEventListener('click', () => submitChoice(button.dataset.choice));
  });
  root.querySelector('#answer-input')?.addEventListener('compositionstart', () => { isComposing = true; });
  root.querySelector('#answer-input')?.addEventListener('compositionend', (event) => {
    state.draft = event.target.value;
    sendRoundDraft(event.target.value, boundPrompt, boundPhase, boundRoundIndex);
    // Some IMEs emit one final input event after compositionend. Let it land
    // before replacing the form, then discard it if the question has changed.
    setTimeout(() => {
      isComposing = false;
      if (pendingDraftReset) state.draft = '';
      pendingDraftReset = false;
      if (pendingRender) {
        const kind = pendingRender;
        pendingRender = null;
        renderWhenReady(kind);
      }
    }, 0);
  });
  root.querySelector('#answer-input')?.addEventListener('input', (event) => {
    state.draft = event.target.value;
    sendRoundDraft(event.target.value, boundPrompt, boundPhase, boundRoundIndex);
    // During the typing test, a perfectly typed sentence advances on its own
    // so children who forget Enter are not undercounted.
    const prompt = state.data?.prompt;
    const expected = prompt?.kind === 'practice' ? prompt.word : prompt?.kind === 'placement' ? prompt.sentence : '';
    if (expected && !event.isComposing && event.target.value.trim() === expected) submitAnswer();
  });
  root.querySelector('#answer-input')?.focus();
}

function updateDynamic() {
  const data = state.data;
  if (!data) return;
  const settingValue = document.querySelector('#score-setting-value');
  if (settingValue) settingValue.textContent = data.self?.isHost && SCORE_SETTING_PHASES.includes(data.phase) ? `현재 ${data.scoreMultiplier || 1}배` : `×${data.scoreMultiplier || 1}`;
  document.querySelectorAll('[data-score-multiplier]').forEach((button) => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.scoreMultiplier) === (data.scoreMultiplier || 1)));
  });
  const time = document.querySelector('#arena-time');
  if (time) time.textContent = data.phase === 'round' ? getTimeLabel(data.timeRemainingMs) : data.phase === 'roundIntro' ? getTimeLabel(data.roundIntroRemainingMs) : data.phase === 'intermission' ? getTimeLabel(data.intermissionRemainingMs) : data.phase === 'wheel' ? getTimeLabel(data.wheelRemainingMs) : '완료';
  document.querySelectorAll('.intro-time').forEach((introTime) => { introTime.textContent = getTimeLabel(data.roundIntroRemainingMs); });
  const overtimeBadge = document.querySelector('#overtime-badge');
  if (overtimeBadge) { overtimeBadge.hidden = !data.overtimeCount; overtimeBadge.textContent = `연장전 ${data.overtimeCount || 0}`; }
  const blueScore = document.querySelector('#blue-score');
  const whiteScore = document.querySelector('#white-score');
  const blueCount = document.querySelector('#blue-count');
  const whiteCount = document.querySelector('#white-count');
  const blueMultiplier = document.querySelector('#blue-multiplier');
  const whiteMultiplier = document.querySelector('#white-multiplier');
  const blueWins = document.querySelector('#blue-wins');
  const whiteWins = document.querySelector('#white-wins');
  const positionLabel = document.querySelector('.scene-position-label');
  if (blueScore) blueScore.textContent = formatScore(data.scores?.blue);
  if (whiteScore) whiteScore.textContent = formatScore(data.scores?.white);
  if (blueCount) blueCount.textContent = `${data.counts?.blue || 0}명`;
  if (whiteCount) whiteCount.textContent = `${data.counts?.white || 0}명`;
  const scoringRule = (team) => getScoringRule(data, team);
  if (blueMultiplier) blueMultiplier.textContent = scoringRule('blue');
  if (whiteMultiplier) whiteMultiplier.textContent = scoringRule('white');
  if (blueWins) blueWins.textContent = `라운드 ${data.roundWins?.blue || 0}승`;
  if (whiteWins) whiteWins.textContent = `라운드 ${data.roundWins?.white || 0}승`;
  const wheelTime = document.querySelector('#wheel-time');
  if (wheelTime) wheelTime.textContent = getTimeLabel(data.wheelRemainingMs);
  const intermissionTime = document.querySelector('#intermission-time');
  if (intermissionTime) intermissionTime.textContent = getTimeLabel(data.intermissionRemainingMs);
  const placementTime = document.querySelector('#placement-time');
  if (placementTime) placementTime.textContent = getTimeLabel(data.placementRemainingMs);
  const placementKeystrokes = document.querySelector('#placement-keystrokes');
  if (placementKeystrokes) placementKeystrokes.textContent = formatScore(data.self?.placementKeystrokes);
  const revealTime = document.querySelector('#reveal-time');
  if (revealTime) revealTime.textContent = getTimeLabel(data.teamRevealRemainingMs);
  if (positionLabel) positionLabel.textContent = getRopeStepLabel(data);
  const currentTick = getRopeMaxSteps(data) + getRopeStep(data);
  document.querySelectorAll('[data-rope-tick]').forEach((tick) => {
    tick.classList.toggle('is-current', Number(tick.dataset.ropeTick) === currentTick);
  });
  tugScene?.update(data);
  const input = document.querySelector('#answer-input');
  if (input && document.activeElement !== input && state.draft) input.value = state.draft;
}

function showWrongAnswer(result) {
  window.clearTimeout(wrongAnswerTimer);
  window.clearTimeout(resultToastTimer);
  state.result = null;
  const toast = document.querySelector('#toast-root');
  if (toast) toast.innerHTML = '';
  state.wrongAnswer = result;
  renderWrongAnswer();
  wrongAnswerTimer = window.setTimeout(() => {
    state.wrongAnswer = null;
    renderWrongAnswer();
    document.querySelector('#answer-input')?.focus();
  }, ANSWER_REVIEW_MS);
}

function renderWrongAnswer() {
  const root = document.querySelector('#wrong-answer-root');
  if (!root) return;
  const result = state.wrongAnswer;
  const main = app.querySelector('main');
  if (main) main.inert = Boolean(result);
  if (!result) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="wrong-answer-backdrop"><section class="wrong-answer-popup" role="alertdialog" aria-modal="true" aria-labelledby="wrong-answer-title" aria-describedby="wrong-answer-details" tabindex="-1">
    <div class="wrong-answer-heading"><h2 id="wrong-answer-title">오답을 함께 확인해요</h2><strong>${result.score < 0 ? '−' : '+'}${formatScore(Math.abs(result.score))}점</strong></div>
    <p class="wrong-answer-question">${escapeHtml(result.question || result.meaning || '')}</p>
    <div id="wrong-answer-details"><p class="wrong-answer-selected"><b>내가 낸 답</b><span>${escapeHtml(result.submittedAnswer || '')}</span></p><p class="wrong-answer-correct"><b>정답</b><span>${escapeHtml(result.answer || result.correctAnswer || result.word || '')}</span></p><div class="wrong-answer-explanation"><b>문제 해설</b><p>${escapeHtml(result.explanation || result.meaning || '정답을 확인하고 다음 문제에 도전해 보세요.')}</p>${result.example ? `<p>예문: ${escapeHtml(result.example)}</p>` : ''}</div></div>
    <p class="wrong-answer-countdown">3초 후 자동으로 닫혀요.</p>
  </section></div>`;
  root.querySelector('.wrong-answer-popup')?.focus();
}

function renderNotice() {
  const root = document.querySelector('#notice-root');
  if (!root) return;
  root.innerHTML = state.notice ? `<div class="notice">${escapeHtml(state.notice)}</div>` : '';
}

function renderResultToast() {
  const root = document.querySelector('#toast-root');
  if (!root || !state.result) return;
  const result = state.result;
  const title = result.title || (result.correct ? '정답이에요!' : '다음 문제에서 만회해요');
  const detailParts = [result.meaning, result.example ? `예문: ${result.example}` : '', result.explanation, result.answer ? `정답: ${result.answer}` : ''].filter(Boolean);
  const details = detailParts.length ? `<small>${detailParts.map((detail) => escapeHtml(detail)).join('<br />')}</small>` : '';
  root.innerHTML = `<div class="result-toast ${result.correct ? 'is-correct' : 'is-wrong'}"><span class="toast-mark">${result.correct ? '✓' : '!'}</span><div><strong>${title}</strong>${details}</div><b>${result.unit === '타' ? '+' : ''}${Math.round(result.score || 0)}${result.unit || '점'}</b></div>`;
  window.clearTimeout(resultToastTimer);
  resultToastTimer = window.setTimeout(() => {
    if (root) root.innerHTML = '';
    state.result = null;
  }, 2_200);
}

document.addEventListener('pointerdown', () => { void unlockSoundEffects(); }, { once: true });
document.addEventListener('keydown', () => { void unlockSoundEffects(); }, { once: true });

connect();
render();
