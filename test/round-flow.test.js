import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { REPAIR_PROMPTS } from '../server/spacing-prompts.js';

const PORT = 18787;
const repairAnswer = (prompt) => REPAIR_PROMPTS.find((item) => item.question === prompt.question).answer;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
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

async function answerQuizCorrectly(client, initialState) {
  let current = initialState;
  while (current.phase === 'round' && current.prompt?.kind === 'quiz') {
    const promptId = current.prompt.id;
    const overtimeCount = current.overtimeCount;
    const nextState = client.waitFor((state) => state.phase !== 'round' || state.prompt?.id !== promptId || state.overtimeCount !== overtimeCount, 8_000);
    const choiceResult = client.waitForMessage('choiceResult', 1_500);
    client.send({ type: 'choice', choice: current.prompt.choices[0] });
    try {
      if ((await choiceResult).correct) return;
    } catch {
      // The round may expire before an answer is accepted; inspect its next state below.
    }
    current = await nextState;
  }
}

test('라운드별 승리, 10초 연장, 2:2 돌림판 결승', async (t) => {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), ROUND_DURATION_MS: '900', ROUND_INTRO_MS: '120', RELAY_DUEL_PAUSE_MS: '80', OVERTIME_MS: '600', INTERMISSION_MS: '200', WHEEL_DURATION_MS: '700', PLACEMENT_MS: '1200', TEAM_REVEAL_MS: '200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('시험 서버 시작 실패')), 5_000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject);
  });

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

  const third = await blue.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  blue.send({ type: 'answer', answer: repairAnswer(third.prompt) });
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
  if (final.prompt.kind === 'repair') blue.send({ type: 'answer', answer: repairAnswer(final.prompt) });
  if (final.prompt.kind === 'relay') {
    blue.send({ type: 'relayAnswer', answer: final.prompt.prompt, deadline: final.relay.deadline });
    white.send({ type: 'relayAnswer', answer: '오답', deadline: final.relay.deadline });
  }
  const result = await blue.waitFor((state) => state.phase === 'results');
  assert.equal(result.winner, 'blue');
  assert.deepEqual(result.roundWins, { blue: 3, white: 2 });
  assert.equal(result.roundScores.length, 5);

  // Twenty rope steps must award only this round, not end the whole match.
  const quickBlueSocket = await connect();
  const quickWhiteSocket = await connect();
  t.after(() => { quickBlueSocket.close(); quickWhiteSocket.close(); });
  const quickBlue = watch(quickBlueSocket);
  const quickWhite = watch(quickWhiteSocket);
  quickBlue.send({ type: 'createRoom', name: '빠른 청', characterId: 'bear' });
  const quickLobby = await quickBlue.waitFor((state) => state.phase === 'lobby' && state.self?.team === 'blue');
  quickWhite.send({ type: 'join', roomId: quickLobby.roomId, name: '빠른 백', characterId: 'cat' });
  await quickWhite.waitFor((state) => state.phase === 'lobby' && state.self?.team === 'white');
  quickBlue.send({ type: 'start' });
  const typedWords = [];
  let quickState = await quickBlue.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  for (let count = 0; count < 40 && quickState.phase === 'round'; count += 1) {
    const { id, word } = quickState.prompt;
    typedWords.push(word);
    quickBlue.send({ type: 'answer', answer: word });
    quickState = await quickBlue.waitFor((state) => state.phase !== 'round' || state.prompt?.id !== id);
  }
  assert.equal(new Set(typedWords).size, typedWords.length, '한 바퀴 안에서는 같은 낱말이 다시 나오지 않아야 해요');
  assert.equal(quickState.phase, 'intermission');
  assert.equal(quickState.roundScores[0].reason, 'rope');
  assert.equal(Math.abs(quickState.ropeStep), 20);
  assert.deepEqual(quickState.roundWins, { blue: 1, white: 0 });
  assert.ok(quickState.players.find((player) => player.id === quickState.self.id).scoreCount >= 1, '점수를 얻으면 이름표 반짝임 카운터가 올라가요');

  // Every player can help in relay; a representative answer moves the rope two steps.
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
  const repairRound1 = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  relayHost.send({ type: 'answer', answer: repairAnswer(repairRound1.prompt) });
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
  assert.equal(cheered.scores.blue, 1, '응원 정답은 정확히 1점을 더해요');
  cheer.send({ type: 'relayAnswer', answer: relayFourth.prompt.prompt, deadline: relayFourth.relay.deadline });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 3)).scores.blue, cheered.scores.blue, '한 대결에 중복 점수를 받지 않아요');
  relayById.get(relayFourth.relay.blueId).send({ type: 'relayAnswer', answer: relayFourth.prompt.prompt, deadline: relayFourth.relay.deadline });
  const represented = await relayHost.waitFor((state) => state.roundIndex === 3 && state.scores.blue > cheered.scores.blue);
  assert.equal(represented.scores.blue - cheered.scores.blue, 150, '대표 정답은 정확히 줄 2칸만큼 점수를 더해요');
  assert.equal(Math.abs(represented.ropeStep - cheered.ropeStep), 2, '대표 정답은 줄을 정확히 2칸 움직여요');
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
  const repairRound2 = await relayHost.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  relayHost.send({ type: 'answer', answer: repairAnswer(repairRound2.prompt) });
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
  relayHost.send({ type: 'draft', promptId: draftRepair.prompt.id, text: draftRepair.prompt.question.slice(0, 4) });
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
