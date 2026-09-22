import './styles.css';

const app = document.querySelector('#app');
const state = {
  connected: false,
  joined: false,
  data: null,
  draft: '',
  result: null,
  notice: '',
  soundEnabled: true,
};

let socket;
let lastViewKey = '';
let lastPromptKey = '';

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
    if (message.type === 'joined') {
      state.joined = true;
      state.data = state.data || {};
      render();
      return;
    }
    if (message.type === 'state') {
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
        Math.round(message.scores?.blue || 0),
        Math.round(message.scores?.white || 0),
        message.counts?.blue,
        message.counts?.white,
        message.players?.map((player) => `${player.id}:${player.connected}`).join(','),
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
  const name = input?.value.trim();
  if (!name) {
    showNotice('닉네임을 입력해 주세요.');
    input?.focus();
    return;
  }
  send({ type: 'join', name });
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
  return `${seconds}초`;
}

function formatScore(value) {
  return Math.round(Number(value || 0)).toLocaleString('ko-KR');
}

function teamName(team) {
  return team === 'blue' ? '청팀' : '백팀';
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
        <a href="https://moonsunezipbrand.vercel.app" target="_blank" rel="noreferrer">문수네집</a>
        <a href="https://www.instagram.com/moonsune.zip/" target="_blank" rel="noreferrer">Instagram</a>
        <a href="https://moonsunezip.com" target="_blank" rel="noreferrer">moonsune.zip</a>
      </nav>
    </header>
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
          <div class="section-kicker">게임 입장</div>
          <h2>이름을 알려 주세요</h2>
          <p class="muted">게임 안에서 사용할 닉네임을 입력하면 팀이 자동으로 배정돼요.</p>
          <label class="field-label" for="nickname">닉네임</label>
          <input id="nickname" class="text-input" maxlength="18" autocomplete="nickname" placeholder="예: 한별" />
          <button id="join-button" class="primary-button">게임 입장하기 <span>→</span></button>
          <div class="rules-mini"><span>01</span><p>순우리말과 한글 문장을 입력해요.</p></div>
          <div class="rules-mini"><span>02</span><p>점수가 팀의 줄을 움직여요.</p></div>
          <div class="rules-mini"><span>03</span><p>마지막에는 랜덤 대표 릴레이가 기다려요.</p></div>
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
          <p class="muted">한 팀씩 번갈아 줄을 잡고, 마지막에는 랜덤 대표가 출전합니다.</p>
        </div>
        ${isHost ? '<button id="start-button" class="primary-button compact">게임 시작 <span>→</span></button>' : '<span class="waiting-pill"><i></i> 진행자를 기다리는 중</span>'}
      </div>
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
      <div class="player-chips">${teamPlayers.map((player) => `<span class="player-chip">${escapeHtml(player.name)}${player.isHost ? '<small>진행</small>' : ''}</span>`).join('') || '<span class="muted">참가자를 기다리는 중</span>'}</div>
    </article>
  `;
}

function renderScoreboard(data) {
  return `
    <div class="scoreboard">
      <div class="score-card score-card--blue">
        <div class="score-card__label"><span class="dot"></span> 청팀 <small>${data.counts.blue}명</small></div>
        <strong>${formatScore(data.scores.blue)}</strong>
        <small class="multiplier">인원 보정 ×${data.multipliers.blue.toFixed(2)}</small>
      </div>
      <div class="score-vs">VS</div>
      <div class="score-card score-card--white">
        <div class="score-card__label"><span class="dot"></span> 백팀 <small>${data.counts.white}명</small></div>
        <strong>${formatScore(data.scores.white)}</strong>
        <small class="multiplier">인원 보정 ×${data.multipliers.white.toFixed(2)}</small>
      </div>
    </div>
  `;
}

function renderArena(data) {
  const position = Math.round(data.ropePosition || 50);
  return `
    <section class="arena-card">
      <div class="arena-topline"><span>세종대왕님 심판</span><span class="arena-time" id="arena-time">${data.phase === 'round' ? getTimeLabel(data.timeRemainingMs) : '준비'}</span></div>
      <div class="tug-stage">
        <div class="team-side team-side--blue">
          <div class="team-side__title"><strong>청팀</strong><span>${data.counts.blue}명의 친구</span></div>
          <div class="puller-row">${createCharacters('blue', data.counts.blue)}</div>
        </div>
        <div class="judge-wrap">
          <div class="judge-avatar"><span class="judge-crown">👑</span><span class="judge-face">🧔🏻</span></div>
          <span class="judge-name">세종대왕님</span>
          <span class="judge-caption">공정한 한글 심판</span>
        </div>
        <div class="team-side team-side--white">
          <div class="team-side__title"><strong>백팀</strong><span>${data.counts.white}명의 친구</span></div>
          <div class="puller-row">${createCharacters('white', data.counts.white)}</div>
        </div>
        <div class="rope-track" aria-label="줄다리기 현재 위치">
          <div class="rope-line"></div>
          <div class="rope-center"></div>
          <div class="rope-knot" id="rope-knot" style="left:${position}%"><span>✦</span></div>
        </div>
      </div>
      <div class="rope-labels"><span>청팀 쪽</span><span>중앙</span><span>백팀 쪽</span></div>
    </section>
  `;
}

function renderPrompt(data) {
  if (data.phase === 'intermission') {
    return `<section class="prompt-card intermission-card"><span class="round-badge">ROUND ${data.roundNumber}</span><h2>다음 라운드를 준비하세요</h2><p>${escapeHtml(data.notice || '')}</p><div class="next-countdown">${getTimeLabel(data.intermissionRemainingMs)}</div></section>`;
  }

  if (data.phase === 'results') {
    const title = data.winner === 'draw' ? '멋진 무승부!' : `${teamName(data.winner)} 승리!`;
    return `<section class="prompt-card result-card"><span class="round-badge">GAME RESULT</span><h2>${title}</h2><p>두 팀 모두 한글의 힘을 보여주었어요.</p><div class="result-stars">✦ ✦ ✦</div><button id="restart-button" class="primary-button">새 게임 준비하기 <span>↗</span></button></section>`;
  }

  if (!data.prompt) return `<section class="prompt-card"><p class="muted">다음 문제를 준비하고 있어요.</p></section>`;

  const prompt = data.prompt;
  if (prompt.kind === 'word') {
    return `
      <section class="prompt-card prompt-card--word">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="prompt-help">순우리말을 정확하게 입력하세요</span></div>
        <h2>${escapeHtml(prompt.word)}</h2>
        <form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="여기에 입력해 주세요" /><button class="submit-button">당기기 <span>↗</span></button></form>
        <p class="prompt-note">정답을 입력하면 뜻과 예문을 바로 만나요.</p>
      </section>
    `;
  }

  if (prompt.kind === 'quiz') {
    return `
      <section class="prompt-card prompt-card--quiz">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="prompt-help">이 뜻에 맞는 단어를 골라 주세요</span></div>
        <div class="meaning-question">${escapeHtml(prompt.meaning)}</div>
        <div class="choice-grid">${prompt.choices.map((choice, index) => `<button class="choice-button" data-choice="${escapeHtml(choice)}"><span>${String.fromCharCode(9312 + index)}</span>${escapeHtml(choice)}</button>`).join('')}</div>
        <p class="prompt-note">빠르고 정확하게 고르면 줄을 더 크게 당겨요.</p>
      </section>
    `;
  }

  if (prompt.kind === 'repair') {
    return `
      <section class="prompt-card prompt-card--repair">
        <div class="prompt-meta"><span class="round-badge">ROUND ${data.roundNumber}</span><span class="prompt-help">바른 문장으로 고쳐 입력하세요</span></div>
        <div class="repair-question">${escapeHtml(prompt.question)}</div>
        <form id="answer-form" class="answer-form"><input id="answer-input" class="answer-input" autocomplete="off" spellcheck="false" placeholder="바르게 고친 문장을 입력하세요" /><button class="submit-button">수리 완료 <span>↗</span></button></form>
      </section>
    `;
  }

  if (prompt.kind === 'relay') {
    const selected = prompt.selected;
    return `
      <section class="prompt-card prompt-card--relay">
        <div class="prompt-meta"><span class="round-badge">FINAL RELAY</span><span class="prompt-help">${selected ? '당신이 이번 팀 대표예요!' : '랜덤 대표 선수의 대결을 지켜봐 주세요'}</span></div>
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
      <div class="game-heading"><div><div class="section-kicker">HANGUL DAY MATCH</div><h1>${escapeHtml(data.mode?.name || '말모이 줄다리기')}</h1><p>${escapeHtml(data.mode?.description || '한글의 힘으로 줄을 당겨요.')}</p></div><div class="live-pill"><i></i> LIVE SERVER</div></div>
      ${renderScoreboard(data)}
      ${renderArena(data)}
      ${renderPrompt(data)}
      <div class="round-strip">${roundModes.map((mode, index) => `<span class="round-chip ${index === data.roundIndex ? 'is-active' : index < data.roundIndex ? 'is-done' : ''}"><b>${index + 1}</b>${modeLabels[mode.id]}</span>`).join('')}</div>
    </section>
  `;
}

function render() {
  const data = state.data;
  app.innerHTML = `${renderHeader()}<main>${data && state.joined && data.phase !== 'lobby' ? renderGame() : renderLobby()}</main><div id="notice-root"></div><div id="toast-root"></div>`;
  bindEvents();
  updateDynamic();
  if (state.notice) renderNotice();
  if (state.result) renderResultToast();
}

function bindEvents() {
  document.querySelector('#join-button')?.addEventListener('click', join);
  document.querySelector('#nickname')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
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
  document.querySelector('#answer-input')?.addEventListener('input', (event) => {
    state.draft = event.target.value;
  });
  document.querySelector('#answer-input')?.focus();
}

function updateDynamic() {
  const data = state.data;
  if (!data) return;
  const time = document.querySelector('#arena-time');
  if (time) time.textContent = data.phase === 'round' ? getTimeLabel(data.timeRemainingMs) : data.phase === 'intermission' ? getTimeLabel(data.intermissionRemainingMs) : data.phase === 'results' ? '완료' : '준비';
  const knot = document.querySelector('#rope-knot');
  if (knot) knot.style.left = `${Math.round(data.ropePosition || 50)}%`;
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
  const details = result.meaning ? `<small>${escapeHtml(result.meaning)}</small>` : result.answer ? `<small>정답: ${escapeHtml(result.answer)}</small>` : '';
  root.innerHTML = `<div class="result-toast ${result.correct ? 'is-correct' : 'is-wrong'}"><span class="toast-mark">${result.correct ? '✓' : '!'}</span><div><strong>${title}</strong>${details}</div><b>${Math.round(result.score || 0)}점</b></div>`;
  window.setTimeout(() => {
    if (root) root.innerHTML = '';
    state.result = null;
  }, 2_200);
}

connect();
render();
