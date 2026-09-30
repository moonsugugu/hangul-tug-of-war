import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 18787;

function connect(port = PORT) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function startServer(t, port, env) {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('시험 서버 시작 실패')), 5_000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(server); });
    server.once('error', reject);
  });
}

function watch(socket) {
  let state;
  const listeners = new Set();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'state') return;
    state = message;
    for (const listener of listeners) listener(message);
  });
  return {
    send(message) { socket.send(JSON.stringify(message)); },
    waitFor(predicate, timeoutMs = 6_000) {
      if (state && predicate(state)) return Promise.resolve(state);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`상태 대기 시간 초과: ${JSON.stringify(state && { phase: state.phase, roundIndex: state.roundIndex, overtimeCount: state.overtimeCount })}`)); }, timeoutMs);
        function check(next) {
          if (!predicate(next)) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(next);
        }
        listeners.add(check);
      });
    },
    waitForMessage(type, timeoutMs = 6_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('message', check); reject(new Error(`응답 대기 시간 초과: ${type}`)); }, timeoutMs);
        function check(raw) {
          const message = JSON.parse(raw.toString());
          if (message.type !== type) return;
          clearTimeout(timer);
          socket.off('message', check);
          resolve(message);
        }
        socket.on('message', check);
      });
    },
  };
}

// 오답은 30점이 깎이므로 '정답 한 번'으로는 팀 점수가 0보다 작을 수 있다.
// 우리 팀 점수가 0보다 커질 때까지(=상대 팀 0점보다 앞설 때까지) 계속 푼다.
async function answerQuizCorrectly(client, initialState) {
  let current = initialState;
  while (current.phase === 'round' && current.prompt?.kind === 'quiz' && !(current.scores?.[current.self?.team] > 0)) {
    const promptId = current.prompt.id;
    const overtimeCount = current.overtimeCount;
    client.send({ type: 'choice', choice: current.prompt.choices[0], promptId });
    current = await client.waitFor((state) => state.phase !== 'round' || state.prompt?.id !== promptId || state.overtimeCount !== overtimeCount, 8_000);
  }
}

test('라운드별 승리, 10초 연장, 2:2 돌림판 결승', async (t) => {
  await startServer(t, PORT, { ROUND_DURATION_MS: '900', ROUND_INTRO_MS: '120', RELAY_DUEL_PAUSE_MS: '80', OVERTIME_MS: '600', INTERMISSION_MS: '200', WHEEL_DURATION_MS: '700', PLACEMENT_MS: '1200', TEAM_REVEAL_MS: '200' });

  const blueSocket = await connect();
  const whiteSocket = await connect();
  t.after(() => { blueSocket.close(); whiteSocket.close(); });
  const blue = watch(blueSocket);
  const white = watch(whiteSocket);
  blue.send({ type: 'createRoom', name: '청', characterId: 'bear' });
  const lobby = await blue.waitFor((state) => state.phase === 'lobby' && state.self?.team === 'blue');
  assert.equal(lobby.prompt.kind, 'practice', '선생님이 시작하기 전에는 우리말 연습 문제가 보여요');
  const practiceWord = lobby.prompt.word;
  blue.send({ type: 'answer', answer: practiceWord });
  const practiced = await blue.waitFor((state) => state.phase === 'lobby' && state.self?.practiceCount === 1);
  assert.equal(practiced.prompt.kind, 'practice');
  assert.notEqual(practiced.prompt.word, practiceWord, '연습을 제출하면 다음 순우리말로 넘어가요');
  white.send({ type: 'join', roomId: lobby.roomId, name: '백', characterId: 'cat' });
  await white.waitFor((state) => state.phase === 'lobby' && state.self?.team === 'white');
  blue.send({ type: 'start' });

  const placement = await blue.waitFor((state) => state.phase === 'placement');
  assert.equal(placement.prompt.kind, 'placement');
  const firstIntro = await blue.waitFor((state) => state.phase === 'roundIntro' && state.roundIndex === 0);
  assert.equal(firstIntro.mode.id, 'word');
  assert.equal(firstIntro.prompt, null, '설명 시간에는 문제가 아직 열리지 않아요');
  assert.equal(firstIntro.roundIntroDurationMs, 120);
  assert.deepEqual(firstIntro.scores, { blue: 0, white: 0 });
  const first = await blue.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  assert.deepEqual(first.scores, { blue: 0, white: 0 });
  const firstWhite = await white.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  assert.equal(firstWhite.self.team, 'white', '아무도 치지 않으면 입장 순서대로 번갈아 배정돼요');
  assert.equal(firstWhite.self.typingSpeed, 0);
  assert.equal(first.totalRounds, 5, '5라운드 결승 슬롯을 항상 보여 줘요');
  assert.equal(first.ropeMaxSteps, 20, '줄을 양쪽으로 20칸씩 당길 수 있어요');
  assert.equal(first.mode.duration, 900);
  const overtime = await blue.waitFor((state) => state.phase === 'round' && state.overtimeCount === 1);
  assert.equal(overtime.roundWins.blue, 0);
  blue.send({ type: 'answer', answer: overtime.prompt.word });
  const firstEnd = await blue.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 0);
  assert.deepEqual(firstEnd.roundWins, { blue: 1, white: 0 });
  assert.equal(firstEnd.roundScores[0].overtimeCount, 1);

  const second = await white.waitFor((state) => state.phase === 'round' && state.roundIndex === 1);
  await answerQuizCorrectly(white, second);
  const secondEnd = await white.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 1);
  assert.equal(secondEnd.roundScores[1].winner, 'white');
  assert.equal(secondEnd.scores.blue, 0);

  await blue.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  blue.send({ type: 'answer', answer: '한글날을 맞아 우리말을 사랑해요' });
  const thirdEnd = await blue.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 2);
  assert.deepEqual(thirdEnd.roundWins, { blue: 2, white: 1 });

  const fourth = await white.waitFor((state) => state.phase === 'round' && state.roundIndex === 3 && state.prompt?.kind === 'relay');
  assert.ok(fourth.players.some((player) => player.id === fourth.relay.blueId && player.team === 'blue'));
  assert.ok(fourth.players.some((player) => player.id === fourth.relay.whiteId && player.team === 'white'));
  white.send({ type: 'relayAnswer', answer: fourth.prompt.prompt, deadline: fourth.relay.deadline });
  blue.send({ type: 'relayAnswer', answer: '오답', deadline: fourth.relay.deadline });
  const nextDuel = await white.waitFor((state) => state.phase === 'round' && state.roundIndex === 3 && state.relay?.deadline !== fourth.relay.deadline);
  assert.ok(nextDuel.scores.white > 0, '대표 점수가 높아도 릴레이 라운드는 계속돼요');
  const wheel = await blue.waitFor((state) => state.phase === 'wheel');
  assert.deepEqual(wheel.roundWins, { blue: 2, white: 2 });
  assert.ok(wheel.wheelSelectedIndex >= 0 && wheel.wheelSelectedIndex < 4);

  const final = await blue.waitFor((state) => state.phase === 'round' && state.roundIndex === 4 && state.prompt);
  assert.equal(final.mode.id, ['word', 'quiz', 'repair', 'relay'][wheel.wheelSelectedIndex]);
  if (final.prompt.kind === 'word') blue.send({ type: 'answer', answer: final.prompt.word });
  if (final.prompt.kind === 'quiz') await answerQuizCorrectly(blue, final);
  if (final.prompt.kind === 'repair') blue.send({ type: 'answer', answer: '한글날을 맞아 우리말을 사랑해요' });
  if (final.prompt.kind === 'relay') {
    blue.send({ type: 'relayAnswer', answer: final.prompt.prompt, deadline: final.relay.deadline });
    white.send({ type: 'relayAnswer', answer: '오답', deadline: final.relay.deadline });
  }
  const result = await blue.waitFor((state) => state.phase === 'results');
  assert.equal(result.winner, 'blue');
  assert.deepEqual(result.roundWins, { blue: 3, white: 2 });
  assert.equal(result.roundScores.length, 5);

  // 릴레이에서도 모두의 타자 점수가 줄을 당기고, 대표 점수는 2배로 들어간다.
  const relaySockets = await Promise.all(Array.from({ length: 4 }, () => connect()));
  t.after(() => relaySockets.forEach((socket) => socket.close()));
  const relayClients = relaySockets.map(watch);
  const relayById = new Map();
  const relayHost = relayClients[0];
  relayHost.send({ type: 'createRoom', name: '응원 방장', characterId: 'bear' });
  const relayLobby = await relayHost.waitFor((state) => state.phase === 'lobby' && state.self);
  relayById.set(relayLobby.self.id, relayHost);
  for (const [index, client] of relayClients.slice(1).entries()) {
    client.send({ type: 'join', roomId: relayLobby.roomId, name: `응원 친구${index}`, characterId: 'cat' });
    const joined = await client.waitFor((state) => state.phase === 'lobby' && state.self);
    relayById.set(joined.self.id, client);
  }
  relayHost.send({ type: 'start' });
  const relayFirst = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  relayHost.send({ type: 'answer', answer: relayFirst.prompt.word });
  const relaySecond = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 1);
  await answerQuizCorrectly(relayHost, relaySecond);
  await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  relayHost.send({ type: 'answer', answer: '한글날을 맞아 우리말을 사랑해요' });
  const relayFourth = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3 && state.relay);
  const blueSupporter = relayFourth.players.find((player) => player.team === 'blue' && player.id !== relayFourth.relay.blueId);
  const whiteSupporter = relayFourth.players.find((player) => player.team === 'white' && player.id !== relayFourth.relay.whiteId);
  assert.ok(blueSupporter, '대표가 아닌 팀원도 있어야 해요');
  const cheer = relayById.get(blueSupporter.id);
  cheer.send({ type: 'relayAnswer', answer: relayFourth.prompt.prompt, deadline: relayFourth.relay.deadline - 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3)).scores.blue, 0, '지난 대결 답안은 점수에 반영하지 않아요');
  cheer.send({ type: 'relayAnswer', answer: relayFourth.prompt.prompt, deadline: relayFourth.relay.deadline });
  const cheered = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3 && state.scores.blue > 0);
  assert.equal(cheered.scores.blue, 150, '대표가 아닌 친구도 다른 라운드처럼 타자 점수(100점 × 4라운드 배율 1.5)를 보태요');
  cheer.send({ type: 'relayAnswer', answer: relayFourth.prompt.prompt, deadline: relayFourth.relay.deadline });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3)).scores.blue, cheered.scores.blue, '한 대결에 중복 점수를 받지 않아요');
  relayById.get(relayFourth.relay.blueId).send({ type: 'relayAnswer', answer: relayFourth.prompt.prompt, deadline: relayFourth.relay.deadline });
  const represented = await relayHost.waitFor((state) => state.roundIndex === 3 && state.scores.blue > cheered.scores.blue);
  assert.equal(represented.scores.blue - cheered.scores.blue, cheered.scores.blue * 2, '대표 점수는 2배로 들어가요');
  assert.equal(Math.abs(represented.ropeStep - cheered.ropeStep), 4, '대표 정답 300점은 줄을 4칸(75점마다 1칸) 움직여요');
  relayById.get(relayFourth.relay.whiteId).send({ type: 'relayAnswer', answer: '오답', deadline: relayFourth.relay.deadline });
  relayById.get(whiteSupporter.id).send({ type: 'relayAnswer', answer: '오답', deadline: relayFourth.relay.deadline });
  const rotated = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3 && state.relay?.deadline !== relayFourth.relay.deadline);
  assert.notEqual(rotated.relay.blueId, relayFourth.relay.blueId, '다음 대결은 다른 청팀 대표를 뽑아요');
  assert.notEqual(rotated.relay.whiteId, relayFourth.relay.whiteId, '다음 대결은 다른 백팀 대표를 뽑아요');
  const relayEnd = await relayHost.waitFor((state) => ['intermission', 'results'].includes(state.phase) && state.roundIndex === 3);
  assert.equal(relayEnd.roundScores[3].winner, 'blue');

  // A relay round with no submissions must not extend forever.
  relayHost.send({ type: 'restart' });
  await relayHost.waitFor((state) => state.phase === 'lobby');
  relayHost.send({ type: 'start' });
  const idleFirst = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  relayHost.send({ type: 'answer', answer: idleFirst.prompt.word });
  const idleSecond = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 1);
  await answerQuizCorrectly(relayHost, idleSecond);
  await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  relayHost.send({ type: 'answer', answer: '한글날을 맞아 우리말을 사랑해요' });
  await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3);
  const idleEnd = await relayHost.waitFor((state) => state.phase === 'results' && state.roundIndex === 3, 8_000);
  assert.equal(idleEnd.roundScores[3].reason, 'tiebreak');
  assert.equal(idleEnd.roundScores[3].overtimeCount, 2);

  // Unsubmitted drafts are scored once when a typing round expires.
  relayHost.send({ type: 'restart' });
  await relayHost.waitFor((state) => state.phase === 'lobby');
  relayHost.send({ type: 'start' });
  const draftWord = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  relayHost.send({ type: 'draft', promptId: draftWord.prompt.id, text: draftWord.prompt.word.slice(0, 1) });
  const wordEnd = await relayHost.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 0);
  assert.ok(wordEnd.scores.blue > 0, '단어를 쓰다 시간이 끝나도 부분 점수가 올라가요');
  const draftQuiz = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 1);
  await answerQuizCorrectly(relayHost, draftQuiz);
  const draftRepair = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  relayHost.send({ type: 'draft', promptId: draftRepair.prompt.id, text: '한글날을 맞아' });
  const repairEnd = await relayHost.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 2);
  assert.ok(repairEnd.scores.blue > 0, '문장을 고치다 시간이 끝나도 부분 점수가 올라가요');
  const draftRelay = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3 && state.relay);
  relayHost.send({ type: 'draft', deadline: draftRelay.relay.deadline, text: draftRelay.prompt.prompt.slice(0, 10) });
  const relayDraftEnd = await relayHost.waitFor((state) => state.phase === 'results' && state.roundIndex === 3, 8_000);
  assert.ok(relayDraftEnd.scores.blue > 0, '릴레이 문장을 쓰다 라운드가 끝나도 부분 점수가 올라가요');
  assert.equal(relayDraftEnd.roundScores[3].winner, 'blue');

  // The two players who actually type must be split across teams.
  const placementSockets = await Promise.all(Array.from({ length: 4 }, () => connect()));
  t.after(() => placementSockets.forEach((socket) => socket.close()));
  const [fastA, fastB, idleC, idleD] = placementSockets.map(watch);
  fastA.send({ type: 'createRoom', name: '빠른가', characterId: 'bear' });
  const placementLobby = await fastA.waitFor((state) => state.phase === 'lobby' && state.self);
  for (const [index, player] of [fastB, idleC, idleD].entries()) {
    player.send({ type: 'join', roomId: placementLobby.roomId, name: `참가${index}`, characterId: 'cat' });
    await player.waitFor((state) => state.phase === 'lobby' && state.self);
  }
  fastA.send({ type: 'start' });
  for (const typist of [fastA, fastB]) {
    const typing = await typist.waitFor((state) => state.phase === 'placement' && state.prompt?.kind === 'placement');
    typist.send({ type: 'answer', answer: typing.prompt.sentence });
    await typist.waitFor((state) => state.self.placementKeystrokes > 0);
  }
  const revealA = await fastA.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  const revealB = await fastB.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  assert.ok(revealA.self.typingSpeed > 0);
  assert.notEqual(revealA.self.team, revealB.self.team);
  assert.deepEqual(revealA.counts, { blue: 2, white: 2 });
  assert.equal(revealA.players.some((player) => 'typingSpeed' in player), false, '다른 사람의 타자 속도는 공개하지 않아요');

  const crowdSockets = await Promise.all(Array.from({ length: 31 }, () => connect()));
  t.after(() => crowdSockets.forEach((socket) => socket.close()));
  const crowdHost = watch(crowdSockets[0]);
  crowdHost.send({ type: 'createRoom', name: '30명 방장', characterId: 'bear' });
  const crowdLobby = await crowdHost.waitFor((state) => state.phase === 'lobby' && state.players.length === 1);
  for (let index = 1; index < 30; index += 1) {
    crowdSockets[index].send(JSON.stringify({ type: 'join', roomId: crowdLobby.roomId, name: `참가자${index}`, characterId: 'cat' }));
  }
  const fullRoom = await crowdHost.waitFor((state) => state.players.length === 30);
  assert.equal(fullRoom.maxPlayers, 30);
  assert.deepEqual(fullRoom.counts, { blue: 15, white: 15 });
  const rejection = new Promise((resolve) => {
    crowdSockets[30].on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'error') resolve(message);
    });
  });
  crowdSockets[30].send(JSON.stringify({ type: 'join', roomId: crowdLobby.roomId, name: '31번째', characterId: 'cat' }));
  assert.match((await rejection).message, /최대 30명/);
});

test('줄을 끝까지 5번 먼저 당겨야 라운드 승리, 2라운드 문제는 다시 나오지 않아요', async (t) => {
  const port = PORT + 1;
  // 시간 제한에 걸리지 않도록 라운드를 길게 둔다.
  await startServer(t, port, { ROUND_DURATION_MS: '60000', ROUND_INTRO_MS: '50', INTERMISSION_MS: '100', PLACEMENT_MS: '300', TEAM_REVEAL_MS: '50' });
  const blueSocket = await connect(port);
  const whiteSocket = await connect(port);
  t.after(() => { blueSocket.close(); whiteSocket.close(); });
  const blue = watch(blueSocket);
  const white = watch(whiteSocket);
  blue.send({ type: 'createRoom', name: '청', characterId: 'bear' });
  const lobby = await blue.waitFor((state) => state.phase === 'lobby' && state.self?.team === 'blue');
  white.send({ type: 'join', roomId: lobby.roomId, name: '백', characterId: 'cat' });
  await white.waitFor((state) => state.phase === 'lobby' && state.self?.team === 'white');
  blue.send({ type: 'start' });

  // 1라운드: 청팀만 낱말을 입력해 줄을 계속 당긴다.
  let state = await blue.waitFor((next) => next.phase === 'round' && next.roundIndex === 0);
  assert.equal(state.ropeEndsToWin, 5);
  assert.deepEqual(state.ropeEnds, { blue: 0, white: 0 });
  const typedWords = [];
  let firstEnd = null;
  for (let count = 0; count < 200 && state.phase === 'round'; count += 1) {
    const { id, word } = state.prompt;
    typedWords.push(word);
    blue.send({ type: 'answer', answer: word });
    state = await blue.waitFor((next) => next.phase !== 'round' || next.prompt?.id !== id);
    if (!firstEnd && state.phase === 'round' && state.ropeEnds.blue === 1) firstEnd = state;
  }
  assert.ok(firstEnd, '줄이 처음 끝에 닿아도 라운드는 끝나지 않아요');
  assert.equal(firstEnd.ropeStep, 0, '끝에 닿으면 줄이 가운데로 돌아가요');
  assert.equal(state.phase, 'intermission');
  assert.equal(state.roundScores[0].reason, 'rope');
  assert.deepEqual(state.roundScores[0].ropeEnds, { blue: 5, white: 0 });
  assert.deepEqual(state.roundWins, { blue: 1, white: 0 });
  assert.ok(typedWords.length >= 75, '20칸(1500점)을 5번 당겨야 하므로 100점짜리 답이 75번 이상 필요해요');
  assert.equal(new Set(typedWords).size, typedWords.length, '한 바퀴 안에서는 같은 낱말이 다시 나오지 않아야 해요');
  assert.ok(state.players.find((player) => player.id === state.self.id).scoreCount >= 1, '점수를 얻으면 이름표 반짝임 카운터가 올라가요');

  // 2라운드: 아주 빨리 풀어도 같은 문제가 다시 나오지 않아야 한다(예전에는 60번째 문제부터 반복).
  state = await blue.waitFor((next) => next.phase === 'round' && next.roundIndex === 1 && next.prompt?.kind === 'quiz');
  const seen = [];
  for (let count = 0; count < 120; count += 1) {
    const { id, category, meaning, choices } = state.prompt;
    seen.push(`${category}|${meaning}`);
    blue.send({ type: 'choice', choice: choices[0], promptId: id });
    state = await blue.waitFor((next) => next.phase !== 'round' || next.prompt?.id !== id);
    assert.equal(state.phase, 'round');
    if (count === 0) {
      // 보기를 두 번 누른 것처럼 지난 문제 번호로 온 답은 다음 문제에 적용하지 않는다.
      const before = state;
      blue.send({ type: 'choice', choice: choices[0], promptId: id });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = await blue.waitFor(() => true);
      assert.equal(after.prompt.id, before.prompt.id, '지난 문제에 늦게 온 답은 무시해요');
      assert.deepEqual(after.scores, before.scores);
    }
  }
  assert.equal(new Set(seen).size, seen.length, '2라운드에서 같은 문제가 다시 나오지 않아야 해요');
  const isWordQuestion = seen.slice(0, 10).map((key) => key.startsWith('순우리말|'));
  assert.deepEqual(isWordQuestion, [true, false, true, false, true, false, true, false, true, false], '순우리말 문제와 한글 창제 문제가 번갈아 나와요');
});
