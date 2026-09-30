import './styles.css';
import { mountTugScene } from './tugScene.js';
import { startBgm, stopBgm, unlockSoundEffects, playVictorySound } from './bgm.js';
import QRCode from 'qrcode';

const app = document.querySelector('#app');
const initialRoomId = normalizeRoomId(new URLSearchParams(window.location.search).get('room'));
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
  nickname: '',
  selectedCharacter: 'bear',
};

let socket;
let lastViewKey = '';
let lastPromptKey = '';
let tugScene = null;
let lastCelebrationKey = '';
let isComposing = false;
let pendingRender = null;
let pendingDraftReset = false;

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
  quiz: '네 가지 보기 중 정답을 고르세요. 오답이면 우리 팀 점수가 30점 깎이니 신중하게 골라 주세요!',
  repair: '잘못 붙은 문장을 올바르게 띄어 써서 입력하세요.',
  relay: '모두 같은 문장을 입력해요. 다른 라운드처럼 정확하고 빠를수록 점수가 올라 줄을 당기고, 대표로 뽑힌 친구의 점수는 2배로 들어가요. 대결마다 대표가 바뀝니다.',
};

// 모든 라운드(결승 포함)에 똑같이 적용되는 줄 규칙
function ropeRuleText(data) {
  return `줄을 끝까지 ${data?.ropeEndsToWin || 5}번 먼저 당긴 팀이 라운드 승리! 끝에 닿을 때마다 줄은 가운데로 돌아가요.`;
}

function roundGuideFor(data) {
  return `${roundGuides[data?.mode?.id] || data?.mode?.description || ''} ${ropeRuleText(data)}`.trim();
}

function ropeEndsLabel(data, team) {
  return `끝까지 ${data?.ropeEnds?.[team] || 0}/${data?.ropeEndsToWin || 5}번`;
}

function scoringRuleFor(data, team) {
  const correction = `인원 보정 ×${Number(data?.multipliers?.[team] || 1).toFixed(2)}`;
  return data?.mode?.id === 'relay' ? `대표 점수 ×${data.relayRepresentativeMultiplier || 2} · ${correction}` : correction;
}

function winningTeamForCelebration(data) {
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

// 라운드 도중 줄이 한쪽 끝에 닿으면(마지막 승리 순간 제외) 몇 번째인지 알려 준다.
let lastRopeEndsKey = '';
let lastRopeEnds = { blue: 0, white: 0 };
function announceRopeEnds(data) {
  const ends = data.ropeEnds || { blue: 0, white: 0 };
  const key = `${data.roomId}:${data.roundIndex}`;
  if (key !== lastRopeEndsKey) {
    lastRopeEndsKey = key;
    lastRopeEnds = { ...ends };
    return;
  }
  if (data.phase === 'round') {
    const team = ['blue', 'white'].find((entry) => (ends[entry] || 0) > (lastRopeEnds[entry] || 0));
    if (team) showNotice(`${teamName(team)}이 줄을 끝까지 당겼어요! (${ends[team]}/${data.ropeEndsToWin || 5}번) 줄이 가운데로 돌아가요.`);
  }
  lastRopeEnds = { ...ends };
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
  socket = new WebSocket(`${protocol}://${host}/ws`);

  socket.addEventListener('open', () => {
    state.connected = true;
    render();
  });
  socket.addEventListener('close', () => {
    state.connected = false;
    state.joined = false;
    render();
    setTimeout(connect, 1500);
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'roomCreated') {
      state.roomId = normalizeRoomId(message.roomId);
      state.roomUrl = message.roomUrl || state.roomUrl;
      updateRoomUrl(state.roomId);
      render();
      return;
    }
    if (message.type === 'joined') {
      state.roomId = normalizeRoomId(message.roomId) || state.roomId;
      state.roomUrl = message.roomUrl || state.roomUrl;
      updateRoomUrl(state.roomId);
      state.joined = true;
      state.data = state.data || {};
      render();
      return;
    }
    if (message.type === 'state') {
      state.roomId = normalizeRoomId(message.roomId) || state.roomId;
      state.roomUrl = message.roomUrl || state.roomUrl;
      state.data = message;
      state.joined = Boolean(message.self);
      celebrateWinIfNeeded(message);
      announceRopeEnds(message);
      trackScoreFlashes(message.players);
      updateDynamic();
      // The page (and its 3D arena) is rebuilt only when the page itself changes;
      // a new question only swaps the prompt card so the arena never blanks out.
      const viewKey = [
        message.phase,
        message.mode?.id,
        message.roundIndex,
        message.counts?.blue,
        message.counts?.white,
        message.self?.team,
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
    if (message.type === 'answerResult' || message.type === 'choiceResult') {
      state.result = message.type === 'choiceResult' && !message.correct
        ? { ...message, title: '오답! 우리 팀 점수 30점 감점' }
        : message;
      state.draft = '';
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
      const title = message.correct
        ? (message.representative ? '대표 정답! 점수 2배로 줄을 당겨요!' : '정답! 내 점수만큼 줄을 당겨요!')
        : message.score > 0 ? '아쉬워요, 맞게 쓴 만큼 점수를 보태요' : '아쉬워요, 다음 문장에서 다시 도전해요';
      state.result = { correct: message.correct, score: message.score, title };
      state.draft = '';
      renderResultToast();
      return;
    }
    if (message.type === 'timeoutScore') {
      state.result = {
        correct: true,
        score: message.score,
        title: message.relay
          ? message.representative ? '시간 종료! 대표가 쓴 만큼 2배 점수' : '시간 종료! 입력한 만큼 부분 점수'
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
  send({ type: 'join', roomId: state.roomId, name, characterId: state.selectedCharacter });
}

function createRoom() {
  const input = document.querySelector('#nickname');
  const name = (state.nickname || input?.value || '').trim();
  if (!name) {
    showNotice('닉네임을 입력해 주세요.');
    input?.focus();
    return;
  }
  send({ type: 'createRoom', name, characterId: state.selectedCharacter });
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
  state.roomId = '';
  state.roomUrl = '';
  updateRoomUrl('');
  render();
}

function getRoomShareUrl() {
  const url = new URL(state.roomUrl || window.location.href);
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

async function renderRoomQr() {
  const image = document.querySelector('#room-qr');
  if (!image || !state.roomId) return;
  try {
    const dataUrl = await QRCode.toDataURL(getRoomShareUrl(), {
      width: 188,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#2f2b37', light: '#fffdf9' },
    });
    if (image.isConnected) image.src = dataUrl;
  } catch (error) {
    console.error('QR 코드를 만들지 못했어요.', error);
  }
}

function startGame() {
  send({ type: 'start' });
}

function restartGame() {
  send({ type: 'restart' });
}

function submitAnswer() {
  const prompt = state.data?.prompt;
  if (!prompt || !['word', 'repair', 'placement', 'practice'].includes(prompt.kind)) return;
  const answer = document.querySelector('#answer-input')?.value ?? state.draft;
  if (!answer.trim()) return;
  send({ type: 'answer', answer });
}

function submitChoice(choice, promptId) {
  send({ type: 'choice', choice, promptId });
}

function submitRelay() {
  const prompt = state.data?.prompt;
  if (prompt?.kind !== 'relay' || prompt.submitted) return;
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
          <span class="brand-mark__title"><strong>말모이 줄다리기</strong><span class="brand-mark__version">ver.1.0.5</span></span>
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

function renderLobby() {
  const data = state.data;
  if (!state.connected) {
    return `<section class="lobby-card connection-card"><span class="loader"></span><p>서버에 연결하고 있어요…</p></section>`;
  }

  if (!state.joined) {
    return `
      <section class="lobby-layout">
        <div class="hero-card">
          <div class="eyebrow">HANGUL DAY · REALTIME GAME</div>
          <h1>우리말을 치고,<br /><em>줄을 당겨요.</em></h1>
          <p>순우리말의 뜻을 만나고, 바른 문장을 완성하며 청팀과 백팀이 한글의 힘으로 겨뤄요.</p>
          <div class="hero-stamps"><span>정확도</span><span>속도</span><span>팀워크</span></div>
        </div>
        <div class="join-card panel-card">
          <div class="section-kicker">${state.roomId ? '방 입장' : '방 만들기'}</div>
          <h2>${state.roomId ? '초대받은 방에 들어가요' : '방을 만들고 친구를 불러요'}</h2>
          <p class="muted">게임 안에서 사용할 닉네임을 입력해 주세요. 게임을 시작하면 타자 실력을 재서 비슷한 실력으로 팀을 나눠요. 한 방에 최대 30명까지 함께할 수 있어요.</p>
          <label class="field-label" for="nickname">닉네임</label>
          <input id="nickname" class="text-input" maxlength="18" autocomplete="nickname" placeholder="예: 한별" value="${escapeHtml(state.nickname)}" />
          <div class="field-label character-field-label">내 캐릭터 <span>하나를 골라 주세요</span></div>
          ${renderCharacterPicker()}
          ${renderRoomEntryControls()}
          <div class="rules-mini"><span>01</span><p>순우리말과 한글 문장을 입력해요.</p></div>
          <div class="rules-mini"><span>02</span><p>점수가 팀의 줄을 움직여요. 줄을 끝까지 5번 먼저 당기면 라운드 승리!</p></div>
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
          <p class="muted">현재 ${players.length}/${data?.maxPlayers || 30}명 · 시작 전에는 우리말 타자로 자유롭게 연습하고, 방장이 시작하면 30초 실력 판정 뒤 자동으로 팀을 나눠요.</p>
        </div>
        ${isHost ? '<button id="start-button" class="primary-button compact">게임 시작 <span>→</span></button>' : '<span class="waiting-pill"><i></i> 진행자를 기다리는 중</span>'}
      </div>
      ${renderRoomShare()}
      <div id="practice-root">${renderPracticeCard(data)}</div>
      <article class="team-lobby-card lobby-roster">
        <div class="team-card-top"><span class="team-badge">모</span><span>참가자</span><strong>${players.length}명</strong></div>
        <div class="player-chips">${players.map((player) => {
          const character = getCharacter(player.characterId);
          const isSelf = player.id === data?.self?.id;
          return `<span class="player-chip ${isSelf ? 'is-self' : ''}"><span aria-hidden="true">${character.emoji}</span>${escapeHtml(player.name)}${isSelf ? '<small>나</small>' : ''}${player.isHost ? '<small>진행</small>' : ''}</span>`;
        }).join('') || '<span class="muted">참가자를 기다리는 중</span>'}</div>
      </article>
      <div class="how-to panel-card">
        <div><span class="how-icon">✦</span><strong>게임 규칙</strong></div>
        <p>위 연습은 점수에 반영되지 않아요. 방장이 시작하면 <b>30초 동안 문장을 입력해 타자 실력을 재고</b>, 팀을 자동으로 나눈 뒤 1라운드를 바로 시작해요. 인원이 적은 팀에는 인원수 비율만큼 보정 점수가 적용돼요.</p>
      </div>
    </section>
  `;
}

function renderPlacement(data) {
  const seconds = Math.round(Number(data.placementDurationMs || 30_000) / 1000);
  return `
    <section class="game-page placement-page">
      <div class="game-heading"><div><div class="section-kicker">TEAM PLACEMENT · 팀 나누기 전</div><h1>타자 실력 재기</h1><p>${seconds}초 동안 문장을 정확하게 입력하세요. 실력이 비슷하도록 팀을 나눠 드려요.</p></div><div class="placement-timer" role="timer"><small>남은 시간</small><strong id="placement-time">${getTimeLabel(data.placementRemainingMs)}</strong></div></div>
      <div id="prompt-root">${renderPlacementCard(data)}</div>
    </section>
  `;
}

function renderPlacementCard(data) {
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
  const myTeam = self?.team || 'blue';
  const roster = (team) => (data.players || []).filter((player) => player.team === team).map((player) => {
    const character = getCharacter(player.characterId);
    return `<span class="player-chip ${player.id === self?.id ? 'is-self' : ''}"><span aria-hidden="true">${character.emoji}</span>${escapeHtml(player.name)}${player.id === self?.id ? '<small>나</small>' : ''}</span>`;
  }).join('');
  return `
    <section class="game-page team-reveal-page">
      <section class="team-reveal-card team-reveal-card--${myTeam}">
        <div class="section-kicker">MY TEAM</div>
        <div class="team-reveal-seal" aria-hidden="true">${myTeam === 'blue' ? '청' : '백'}</div>
        <h1>${escapeHtml(self?.name || '')}님은 <em>${teamName(myTeam)}</em>이에요!</h1>
        <p>내 타자 속도 <b>분당 ${formatScore(self?.typingSpeed)}타</b> · 실력이 비슷하도록 팀을 나눴어요.</p>
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
  const mine = (team) => (data.self?.team === team ? ' is-mine' : '');
  const mineTag = (team) => (data.self?.team === team ? '<span class="mine-tag">우리 팀</span>' : '');
  return `
    <div class="scoreboard">
      <div class="score-card score-card--blue${mine('blue')}">
        <div class="score-card__label"><span class="dot"></span> 청팀 <small id="blue-count">${data.counts.blue}명</small>${mineTag('blue')}</div>
        <strong id="blue-score">${formatScore(data.scores.blue)}</strong>
        <small class="multiplier" id="blue-multiplier">${scoringRuleFor(data, 'blue')}</small><span class="round-wins" id="blue-wins">라운드 ${data.roundWins?.blue || 0}승</span><span class="rope-ends" id="blue-ends">${ropeEndsLabel(data, 'blue')}</span>
      </div>
      <div class="score-vs">VS</div>
      <div class="score-card score-card--white${mine('white')}">
        <div class="score-card__label"><span class="dot"></span> 백팀 <small id="white-count">${data.counts.white}명</small>${mineTag('white')}</div>
        <strong id="white-score">${formatScore(data.scores.white)}</strong>
        <small class="multiplier" id="white-multiplier">${scoringRuleFor(data, 'white')}</small><span class="round-wins" id="white-wins">라운드 ${data.roundWins?.white || 0}승</span><span class="rope-ends" id="white-ends">${ropeEndsLabel(data, 'white')}</span>
      </div>
    </div>
  `;
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
        ${data.phase === 'roundIntro' ? `<div class="round-intro-overlay" role="status"><span>${data.roundNumber === 5 ? '결승' : `${data.roundNumber}라운드`} 시작 안내</span><h2>${escapeHtml(data.mode?.name || '')}</h2><p>${escapeHtml(roundGuideFor(data))}</p><strong><span class="intro-time">${getTimeLabel(data.roundIntroRemainingMs)}</span> 뒤 시작!</strong></div>` : ''}
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
    return `<section class="prompt-card round-intro-card"><span class="round-badge">${data.roundNumber === 5 ? 'FINAL ROUND' : `ROUND ${data.roundNumber}`}</span><h2>${escapeHtml(data.mode?.name || '')}</h2><p>${escapeHtml(roundGuideFor(data))}</p><div class="next-countdown"><span class="intro-time">${getTimeLabel(data.roundIntroRemainingMs)}</span> 뒤 시작해요!</div></section>`;
  }
  if (data.phase === 'wheel') {
    const selected = Number(data.wheelSelectedIndex ?? 0);
    return `<section class="prompt-card wheel-card" style="--wheel-turns:${1440 - selected * 90}deg;--wheel-duration:${Math.round(Number(data.wheelDurationMs || 7000) * .65)}ms"><span class="round-badge">FINAL ROUND</span><h2>2:2 동점! 결승 종목 돌림판</h2><p>1~4라운드 중 하나를 다시 겨뤄 최종 승자를 정해요.</p><div class="wheel-wrap"><div class="wheel-pointer" aria-hidden="true"></div><div class="game-wheel"><span>말모이</span><span>뜻풀이</span><span>바른말</span><span>릴레이</span></div></div><p class="wheel-countdown">결승까지 <span id="wheel-time">${getTimeLabel(data.wheelRemainingMs)}</span></p><p class="wheel-result">선정 종목: <strong>${escapeHtml(modeLabels[roundModes[selected]?.id] || '')}</strong></p></section>`;
  }

  if (data.phase === 'intermission') {
    const lastRound = data.roundScores?.at(-1);
    const ends = lastRound?.ropeEnds || { blue: 0, white: 0 };
    return `<section class="prompt-card intermission-card"><span class="round-badge">ROUND ${data.roundNumber} RESULT</span><h2>${teamName(lastRound?.winner)} 라운드 승리!</h2><p>${escapeHtml(data.notice || '')}</p><div class="round-result-score">끝까지 당긴 횟수 청 ${ends.blue} : ${ends.white} 백</div><p>점수 청 ${formatScore(lastRound?.blue)} : ${formatScore(lastRound?.white)} 백</p><div class="next-countdown">다음 라운드 ${getTimeLabel(data.intermissionRemainingMs)}</div></section>`;
  }

  if (data.phase === 'results') {
    return `<section class="prompt-card result-card"><span class="round-badge">GAME RESULT</span><h2>${teamName(data.winner)} 최종 승리!</h2><p>라운드 승수 청팀 ${data.roundWins?.blue || 0} : ${data.roundWins?.white || 0} 백팀</p><div class="round-results">${(data.roundScores || []).map((round) => `<span>${round.round}R ${escapeHtml(round.mode)} · <b>${teamName(round.winner)} 승</b></span>`).join('')}</div><div class="result-stars">✦ ✦ ✦</div><button id="restart-button" class="primary-button">새 게임 준비하기 <span>↗</span></button></section>`;
  }

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
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="category-badge ${prompt.category === '순우리말' ? '' : 'category-badge--history'}">${escapeHtml(prompt.category || '뜻풀이')}</span><span class="prompt-help">${prompt.category === '순우리말' ? '이 뜻에 맞는 순우리말을 골라 주세요' : '한글 창제 원리와 세종대왕의 기록을 떠올려 골라 주세요'}</span></div>
        ${prompt.category !== '순우리말' ? '<div class="history-ribbon">한글과 세종대왕 배움 카드</div>' : ''}
        <div class="meaning-question">${escapeHtml(prompt.meaning)}</div>
        <div class="choice-grid">${prompt.choices.map((choice, index) => `<button class="choice-button" data-choice="${escapeHtml(choice)}"><span>${String.fromCharCode(9312 + index)}</span>${escapeHtml(choice)}</button>`).join('')}</div>
        <p class="prompt-note">정답은 점수를 얻고, 오답은 우리 팀 점수 30점 감점!</p>
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
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}${data.roundNumber === 5 ? ' FINAL' : ''}</span><span class="prompt-help">${selected ? '당신이 이번 팀 대표예요! 내 점수가 2배로 들어가요' : '같은 문장을 입력하면 내 점수만큼 줄을 당겨요'}</span></div>
        <div class="relay-versus"><span>청팀 대표 <strong>${escapeHtml(representativeName(data.relay?.blueId))}</strong></span><b>VS</b><span>백팀 대표 <strong>${escapeHtml(representativeName(data.relay?.whiteId))}</strong></span></div>
        <div class="relay-sentence">${escapeHtml(prompt.prompt)}</div>
        <p class="relay-scoring-note">모두의 점수가 줄을 당겨요 · 대표 점수 2배 · 대결마다 대표가 바뀌어요</p>
        ${prompt.submitted ? '<div class="spectator-message">입력 완료! 다음 문장을 기다려 주세요.</div>' : `<form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="문장을 똑같이 입력해 주세요" /><button class="submit-button">${selected ? '대표 출전' : '함께 당기기'} <span>↗</span></button></form>`}
      </section>
    `;
  }

  return '';
}

function renderGame() {
  const data = state.data;
  const finalRoundActive = data.roundIndex === 4 || data.phase === 'wheel';
  const finalRoundPending = !finalRoundActive && data.roundIndex < 4;
  return `
    <section class="game-page">
      <div class="game-heading"><div><div class="section-kicker">HANGUL DAY MATCH · ${data.roundNumber === 5 ? '결승 5라운드' : `${Math.max(1, data.roundNumber)}라운드`}</div><h1>${escapeHtml(data.mode?.name || '말모이 줄다리기')}</h1><p>${escapeHtml(data.mode?.description || '한글의 힘으로 줄을 당겨요.')}</p></div>${data.self ? `<div class="my-team-chip my-team-chip--${data.self.team}"><span>${data.self.team === 'blue' ? '청' : '백'}</span><div><small>${escapeHtml(data.self.name)}</small><strong>나는 ${teamName(data.self.team)}</strong></div></div>` : '<div class="live-pill"><i></i> LIVE SERVER</div>'}</div>
      ${renderScoreboard(data)}
      ${renderArena(data)}
      <div id="prompt-root">${renderPrompt(data)}</div>
      <div class="round-strip">${roundModes.map((mode, index) => `<span class="round-chip ${index === data.roundIndex ? 'is-active' : index < data.roundIndex ? 'is-done' : ''}"><b>${index + 1}</b>${modeLabels[mode.id]}${data.roundScores?.[index] ? ` · ${teamName(data.roundScores[index].winner)} 승` : ''}</span>`).join('')}<span class="round-chip round-chip--final ${finalRoundActive ? 'is-active' : ''} ${finalRoundPending ? 'is-optional' : ''}" title="1~4라운드가 2:2로 끝나면 열립니다"><b>5</b>돌림판 결승${finalRoundPending ? ' · 2:2일 때' : ''}</span></div>
    </section>
  `;
}

function render() {
  isComposing = false;
  pendingRender = null;
  pendingDraftReset = false;
  const data = state.data;
  const inRoomPhase = Boolean(data?.phase && state.joined && data.phase !== 'lobby');
  const isGame = inRoomPhase && !['placement', 'teamReveal'].includes(data.phase);
  if (tugScene) {
    tugScene.dispose();
    tugScene = null;
  }
  const page = !inRoomPhase ? renderLobby()
    : data.phase === 'placement' ? renderPlacement(data)
      : data.phase === 'teamReveal' ? renderTeamReveal(data)
        : renderGame();
  app.innerHTML = `${renderHeader()}<main>${page}</main><div id="notice-root"></div><div id="toast-root"></div>`;
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
}

function bindEvents() {
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
  const boundPrompt = state.data?.prompt;
  const boundPhase = state.data?.phase;
  const boundRoundIndex = state.data?.roundIndex;
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
    button.addEventListener('click', () => submitChoice(button.dataset.choice, boundPrompt?.id));
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
  if (blueMultiplier) blueMultiplier.textContent = scoringRuleFor(data, 'blue');
  if (whiteMultiplier) whiteMultiplier.textContent = scoringRuleFor(data, 'white');
  if (blueWins) blueWins.textContent = `라운드 ${data.roundWins?.blue || 0}승`;
  if (whiteWins) whiteWins.textContent = `라운드 ${data.roundWins?.white || 0}승`;
  const blueEnds = document.querySelector('#blue-ends');
  const whiteEnds = document.querySelector('#white-ends');
  if (blueEnds) blueEnds.textContent = ropeEndsLabel(data, 'blue');
  if (whiteEnds) whiteEnds.textContent = ropeEndsLabel(data, 'white');
  const wheelTime = document.querySelector('#wheel-time');
  if (wheelTime) wheelTime.textContent = getTimeLabel(data.wheelRemainingMs);
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
  window.setTimeout(() => {
    if (root) root.innerHTML = '';
    state.result = null;
  }, 2_200);
}

document.addEventListener('pointerdown', () => { void unlockSoundEffects(); }, { once: true });
document.addEventListener('keydown', () => { void unlockSoundEffects(); }, { once: true });

connect();
render();
