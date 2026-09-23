import './styles.css';
import { mountTugScene } from './tugScene.js';
import { startBgm, stopBgm } from './bgm.js';
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
      updateDynamic();
      const viewKey = [
        message.phase,
        message.mode?.id,
        message.roundIndex,
        message.prompt?.id,
        message.relay?.blueId,
        message.relay?.whiteId,
        message.relay?.lastResult?.winner,
        message.counts?.blue,
        message.counts?.white,
        message.players?.map((player) => `${player.id}:${player.connected}:${player.characterId}`).join(','),
      ].join('|');
      if (viewKey !== lastViewKey) {
        lastViewKey = viewKey;
        render();
      }
      return;
    }
    if (message.type === 'answerResult' || message.type === 'choiceResult') {
      state.result = message;
      state.draft = '';
      renderResultToast();
      return;
    }
    if (message.type === 'relayAnswerResult') {
      state.result = { correct: message.correct, score: message.correct ? 100 : 0 };
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
  if (!prompt || !['word', 'repair'].includes(prompt.kind)) return;
  const answer = document.querySelector('#answer-input')?.value ?? state.draft;
  if (!answer.trim()) return;
  send({ type: 'answer', answer });
}

function submitChoice(choice) {
  send({ type: 'choice', choice });
}

function submitRelay() {
  const prompt = state.data?.prompt;
  if (!prompt?.selected) return;
  const answer = document.querySelector('#answer-input')?.value ?? state.draft;
  if (!answer.trim()) return;
  send({ type: 'relayAnswer', answer });
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
          <strong>말모이 줄다리기</strong>
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
          <p class="muted">게임 안에서 사용할 닉네임을 입력하면 팀이 자동으로 배정돼요. 한 방에 최대 30명까지 함께할 수 있어요.</p>
          <label class="field-label" for="nickname">닉네임</label>
          <input id="nickname" class="text-input" maxlength="18" autocomplete="nickname" placeholder="예: 한별" value="${escapeHtml(state.nickname)}" />
          <div class="field-label character-field-label">내 캐릭터 <span>하나를 골라 주세요</span></div>
          ${renderCharacterPicker()}
          ${renderRoomEntryControls()}
          <div class="rules-mini"><span>01</span><p>순우리말과 한글 문장을 입력해요.</p></div>
          <div class="rules-mini"><span>02</span><p>점수가 팀의 줄을 움직여요.</p></div>
          <div class="rules-mini"><span>03</span><p>각 라운드 3분! 4라운드 뒤 2:2면 돌림판 결승을 진행해요.</p></div>
        </div>
      </section>
    `;
  }

  const bluePlayers = data?.players?.filter((player) => player.team === 'blue') || [];
  const whitePlayers = data?.players?.filter((player) => player.team === 'white') || [];
  const isHost = data?.self?.isHost;

  return `
    <section class="lobby-room">
      <div class="lobby-title-row">
        <div>
          <div class="section-kicker">WAITING ROOM</div>
          <h1>모두 모이면 시작해요</h1>
          <p class="muted">현재 ${data?.players?.length || 0}/${data?.maxPlayers || 30}명 · 라운드마다 승부를 정하고, 동점이면 10초씩 연장합니다.</p>
        </div>
        ${isHost ? '<button id="start-button" class="primary-button compact">게임 시작 <span>→</span></button>' : '<span class="waiting-pill"><i></i> 진행자를 기다리는 중</span>'}
      </div>
      ${renderRoomShare()}
      <div class="team-grid lobby-teams">
        ${renderTeamLobby('blue', bluePlayers, data?.counts?.blue || bluePlayers.length)}
        ${renderTeamLobby('white', whitePlayers, data?.counts?.white || whitePlayers.length)}
      </div>
      <div class="how-to panel-card">
        <div><span class="how-icon">✦</span><strong>게임 규칙</strong></div>
        <p>청팀과 백팀의 점수는 서버에서 계산되고, 인원이 적은 팀에는 <b>인원수 비율만큼 보정 점수</b>가 적용돼요.</p>
      </div>
    </section>
  `;
}

function renderTeamLobby(team, teamPlayers, count) {
  return `
    <article class="team-lobby-card team-lobby-card--${team}">
      <div class="team-card-top"><span class="team-badge">${team === 'blue' ? '청' : '백'}</span><span>${teamName(team)}</span><strong>${count}명</strong></div>
      <div class="player-chips">${teamPlayers.map((player) => {
        const character = getCharacter(player.characterId);
        return `<span class="player-chip"><span aria-hidden="true">${character.emoji}</span>${escapeHtml(player.name)}${player.isHost ? '<small>진행</small>' : ''}</span>`;
      }).join('') || '<span class="muted">참가자를 기다리는 중</span>'}</div>
    </article>
  `;
}

function renderScoreboard(data) {
  return `
    <div class="scoreboard">
      <div class="score-card score-card--blue">
        <div class="score-card__label"><span class="dot"></span> 청팀 <small id="blue-count">${data.counts.blue}명</small></div>
        <strong id="blue-score">${formatScore(data.scores.blue)}</strong>
        <small class="multiplier" id="blue-multiplier">인원 보정 ×${data.multipliers.blue.toFixed(2)}</small><span class="round-wins" id="blue-wins">라운드 ${data.roundWins?.blue || 0}승</span>
      </div>
      <div class="score-vs">VS</div>
      <div class="score-card score-card--white">
        <div class="score-card__label"><span class="dot"></span> 백팀 <small id="white-count">${data.counts.white}명</small></div>
        <strong id="white-score">${formatScore(data.scores.white)}</strong>
        <small class="multiplier" id="white-multiplier">인원 보정 ×${data.multipliers.white.toFixed(2)}</small><span class="round-wins" id="white-wins">라운드 ${data.roundWins?.white || 0}승</span>
      </div>
    </div>
  `;
}

function renderArena(data) {
  const position = Math.round(data.ropePosition ?? 50);
  const ropeStep = getRopeStep(data);
  const bluePlayers = data.players?.filter((player) => player.team === 'blue') || [];
  const whitePlayers = data.players?.filter((player) => player.team === 'white') || [];
  const crowded = bluePlayers.length + whitePlayers.length > 8;
  return `
    <section class="arena-card">
      <div class="arena-topline"><span><b>세종대왕님</b>이 공정하게 심판해요 <em class="overtime-badge" id="overtime-badge" ${data.overtimeCount ? '' : 'hidden'}>연장전 ${data.overtimeCount}</em></span></div>
      <div class="three-arena" id="three-arena" data-rope-position="${position}" aria-label="청팀과 백팀 캐릭터가 줄다리기하는 3차원 경기장">
        <button type="button" class="bgm-toggle" id="bgm-toggle" aria-pressed="${state.soundEnabled}">🥁 BGM ${state.soundEnabled ? '끄기' : '켜기'}</button>
        <div class="scene-overlay">
          <span class="scene-team-tag scene-team-tag--blue" aria-hidden="true">청팀 · ${data.counts.blue}명</span>
          <div class="scene-judge-stack">
            <div class="arena-time" role="timer"><small>${data.phase === 'round' ? `${data.roundNumber}라운드 남은 시간` : data.phase === 'intermission' ? '다음 라운드까지' : data.phase === 'wheel' ? '결승 준비' : '경기 종료'}</small><strong id="arena-time">${data.phase === 'round' ? getTimeLabel(data.timeRemainingMs) : data.phase === 'intermission' ? getTimeLabel(data.intermissionRemainingMs) : data.phase === 'wheel' ? getTimeLabel(data.wheelRemainingMs) : '완료'}</strong></div>
            <div class="scene-judge-copy" aria-hidden="true"><strong>한글 사랑해요</strong><small>세종대왕님 감사해요</small></div>
          </div>
          <span class="scene-team-tag scene-team-tag--white" aria-hidden="true">백팀 · ${data.counts.white}명</span>
        </div>
        <div class="scene-step-track" aria-hidden="true"><b>청</b>${Array.from({ length: 21 }, (_, index) => `<i class="rope-step ${index === 10 + ropeStep ? 'is-current' : ''}" data-rope-tick="${index}"></i>`).join('')}<b>백</b></div>
        <div class="scene-position-label" aria-live="polite">${getRopeStepLabel(data)}</div>
      </div>
      <div class="scene-accessibility"><strong>경기장 안내</strong> ${crowded ? `청팀 ${bluePlayers.length}명 · 백팀 ${whitePlayers.length}명 참가 중` : `청팀 ${bluePlayers.map((player) => `${getCharacter(player.characterId).name} ${player.name}`).join(', ') || '참가자 없음'} · 백팀 ${whitePlayers.map((player) => `${getCharacter(player.characterId).name} ${player.name}`).join(', ') || '참가자 없음'}`}</div>
    </section>
  `;
}

function getRopeStep(data) {
  const inferred = Math.round(((Number(data.ropePosition ?? 50) - 50) / 43) * 10);
  return Math.max(-10, Math.min(10, Number(data.ropeStep ?? inferred)));
}

function getRopeStepLabel(data) {
  const step = getRopeStep(data);
  return step === 0 ? '줄 위치 중앙 · 0/10칸' : `줄 위치 ${step < 0 ? '청팀' : '백팀'} 방향 ${Math.abs(step)}/10칸`;
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
  if (data.phase === 'wheel') {
    const selected = Number(data.wheelSelectedIndex ?? 0);
    return `<section class="prompt-card wheel-card" style="--wheel-turns:${1440 - selected * 90}deg;--wheel-duration:${Math.round(Number(data.wheelDurationMs || 7000) * .65)}ms"><span class="round-badge">FINAL ROUND</span><h2>2:2 동점! 결승 종목 돌림판</h2><p>1~4라운드 중 하나를 다시 겨뤄 최종 승자를 정해요.</p><div class="wheel-wrap"><div class="wheel-pointer" aria-hidden="true"></div><div class="game-wheel"><span>말모이</span><span>뜻풀이</span><span>바른말</span><span>릴레이</span></div></div><p class="wheel-countdown">결승까지 <span id="wheel-time">${getTimeLabel(data.wheelRemainingMs)}</span></p><p class="wheel-result">선정 종목: <strong>${escapeHtml(modeLabels[roundModes[selected]?.id] || '')}</strong></p></section>`;
  }

  if (data.phase === 'intermission') {
    const lastRound = data.roundScores?.at(-1);
    return `<section class="prompt-card intermission-card"><span class="round-badge">ROUND ${data.roundNumber} RESULT</span><h2>${teamName(lastRound?.winner)} 라운드 승리!</h2><p>${escapeHtml(data.notice || '')}</p><div class="round-result-score">청 ${formatScore(lastRound?.blue)} : ${formatScore(lastRound?.white)} 백</div><div class="next-countdown">다음 라운드 ${getTimeLabel(data.intermissionRemainingMs)}</div></section>`;
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
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="category-badge ${prompt.category === '한글 창제' ? 'category-badge--history' : ''}">${escapeHtml(prompt.category || '뜻풀이')}</span><span class="prompt-help">${prompt.category === '한글 창제' ? '한글 창제 이야기를 떠올려 골라 주세요' : '이 뜻에 맞는 단어를 골라 주세요'}</span></div>
        ${prompt.category === '한글 창제' ? '<div class="history-ribbon">훈민정음 배움 카드 · 세종대왕과 한글 창제</div>' : ''}
        <div class="meaning-question">${escapeHtml(prompt.meaning)}</div>
        <div class="choice-grid">${prompt.choices.map((choice, index) => `<button class="choice-button" data-choice="${escapeHtml(choice)}"><span>${String.fromCharCode(9312 + index)}</span>${escapeHtml(choice)}</button>`).join('')}</div>
        <p class="prompt-note">빠르고 정확하게 고르면 줄을 더 크게 당겨요.</p>
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
    return `
      <section class="prompt-card prompt-card--relay">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}${data.roundNumber === 5 ? ' FINAL' : ''}</span><span class="prompt-help">${selected ? '당신이 이번 팀 대표예요!' : '랜덤 대표 선수의 대결을 지켜봐 주세요'}</span></div>
        <div class="relay-versus"><span>청팀 대표</span><b>VS</b><span>백팀 대표</span></div>
        <div class="relay-sentence">${escapeHtml(prompt.prompt)}</div>
        ${selected ? '<form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="대표 선수만 입력할 수 있어요" /><button class="submit-button">대표 출전 <span>↗</span></button></form>' : '<div class="spectator-message">대표 선수가 문장을 입력하는 중이에요…</div>'}
      </section>
    `;
  }

  return '';
}

function renderGame() {
  const data = state.data;
  return `
    <section class="game-page">
      <div class="game-heading"><div><div class="section-kicker">HANGUL DAY MATCH · ${data.roundNumber === 5 ? '결승 5라운드' : `${Math.max(1, data.roundNumber)}라운드`}</div><h1>${escapeHtml(data.mode?.name || '말모이 줄다리기')}</h1><p>${escapeHtml(data.mode?.description || '한글의 힘으로 줄을 당겨요.')}</p></div><div class="live-pill"><i></i> LIVE SERVER</div></div>
      ${renderScoreboard(data)}
      ${renderArena(data)}
      ${renderPrompt(data)}
      <div class="round-strip">${roundModes.map((mode, index) => `<span class="round-chip ${index === data.roundIndex ? 'is-active' : index < data.roundIndex ? 'is-done' : ''}"><b>${index + 1}</b>${modeLabels[mode.id]}${data.roundScores?.[index] ? ` · ${teamName(data.roundScores[index].winner)} 승` : ''}</span>`).join('')}${data.totalRounds === 5 ? `<span class="round-chip ${data.roundIndex === 4 ? 'is-active' : ''}"><b>5</b>돌림판 결승</span>` : ''}</div>
    </section>
  `;
}

function render() {
  const data = state.data;
  const isGame = Boolean(data?.phase && state.joined && data.phase !== 'lobby');
  if (tugScene) {
    tugScene.dispose();
    tugScene = null;
  }
  app.innerHTML = `${renderHeader()}<main>${isGame ? renderGame() : renderLobby()}</main><div id="notice-root"></div><div id="toast-root"></div>`;
  bindEvents();
  renderRoomQr();
  updateDynamic();
  if (isGame) {
    const sceneHost = document.querySelector('#three-arena');
    if (sceneHost) {
      try {
        tugScene = mountTugScene(sceneHost, data);
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
  document.querySelector('#restart-button')?.addEventListener('click', restartGame);
  document.querySelector('#answer-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.data?.prompt?.kind === 'relay') submitRelay();
    else submitAnswer();
  });
  document.querySelectorAll('[data-choice]').forEach((button) => {
    button.addEventListener('click', () => submitChoice(button.dataset.choice));
  });
  document.querySelectorAll('[data-character]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedCharacter = button.dataset.character;
      render();
    });
  });
  document.querySelector('#answer-input')?.addEventListener('input', (event) => {
    state.draft = event.target.value;
  });
  document.querySelector('#answer-input')?.focus();
}

function updateDynamic() {
  const data = state.data;
  if (!data) return;
  const time = document.querySelector('#arena-time');
  if (time) time.textContent = data.phase === 'round' ? getTimeLabel(data.timeRemainingMs) : data.phase === 'intermission' ? getTimeLabel(data.intermissionRemainingMs) : data.phase === 'wheel' ? getTimeLabel(data.wheelRemainingMs) : '완료';
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
  if (blueMultiplier) blueMultiplier.textContent = `인원 보정 ×${Number(data.multipliers?.blue || 1).toFixed(2)}`;
  if (whiteMultiplier) whiteMultiplier.textContent = `인원 보정 ×${Number(data.multipliers?.white || 1).toFixed(2)}`;
  if (blueWins) blueWins.textContent = `라운드 ${data.roundWins?.blue || 0}승`;
  if (whiteWins) whiteWins.textContent = `라운드 ${data.roundWins?.white || 0}승`;
  const wheelTime = document.querySelector('#wheel-time');
  if (wheelTime) wheelTime.textContent = getTimeLabel(data.wheelRemainingMs);
  if (positionLabel) positionLabel.textContent = getRopeStepLabel(data);
  const currentTick = 10 + getRopeStep(data);
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
  const title = result.correct ? '정답이에요!' : '다음 문제에서 만회해요';
  const detailParts = [result.meaning, result.example ? `예문: ${result.example}` : '', result.explanation, result.answer ? `정답: ${result.answer}` : ''].filter(Boolean);
  const details = detailParts.length ? `<small>${detailParts.map((detail) => escapeHtml(detail)).join('<br />')}</small>` : '';
  root.innerHTML = `<div class="result-toast ${result.correct ? 'is-correct' : 'is-wrong'}"><span class="toast-mark">${result.correct ? '✓' : '!'}</span><div><strong>${title}</strong>${details}</div><b>${Math.round(result.score || 0)}점</b></div>`;
  window.setTimeout(() => {
    if (root) root.innerHTML = '';
    state.result = null;
  }, 2_200);
}

connect();
render();
