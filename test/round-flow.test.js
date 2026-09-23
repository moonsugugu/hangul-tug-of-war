import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 18787;

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
  };
}

test('라운드별 승리, 10초 연장, 2:2 돌림판 결승', async (t) => {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), ROUND_DURATION_MS: '900', OVERTIME_MS: '600', INTERMISSION_MS: '200', WHEEL_DURATION_MS: '700' },
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
  white.send({ type: 'join', roomId: lobby.roomId, name: '백', characterId: 'cat' });
  await white.waitFor((state) => state.phase === 'lobby' && state.self?.team === 'white');
  blue.send({ type: 'start' });

  const first = await blue.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  assert.equal(first.mode.duration, 900);
  const overtime = await blue.waitFor((state) => state.phase === 'round' && state.overtimeCount === 1);
  assert.equal(overtime.roundWins.blue, 0);
  blue.send({ type: 'answer', answer: '윤슬' });
  const firstEnd = await blue.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 0);
  assert.deepEqual(firstEnd.roundWins, { blue: 1, white: 0 });
  assert.equal(firstEnd.roundScores[0].overtimeCount, 1);

  const second = await white.waitFor((state) => state.phase === 'round' && state.roundIndex === 1);
  white.send({ type: 'choice', choice: second.prompt.choices[0] });
  const secondEnd = await white.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 1);
  assert.equal(secondEnd.roundScores[1].winner, 'white');
  assert.equal(secondEnd.scores.blue, 0);

  await blue.waitFor((state) => state.phase === 'round' && state.roundIndex === 2);
  blue.send({ type: 'answer', answer: '한글날을 맞아 우리말을 사랑해요' });
  const thirdEnd = await blue.waitFor((state) => state.phase === 'intermission' && state.roundIndex === 2);
  assert.deepEqual(thirdEnd.roundWins, { blue: 2, white: 1 });

  const fourth = await white.waitFor((state) => state.phase === 'round' && state.roundIndex === 3 && state.prompt?.kind === 'relay');
  white.send({ type: 'relayAnswer', answer: fourth.prompt.prompt });
  blue.send({ type: 'relayAnswer', answer: '오답' });
  const wheel = await blue.waitFor((state) => state.phase === 'wheel');
  assert.deepEqual(wheel.roundWins, { blue: 2, white: 2 });
  assert.ok(wheel.wheelSelectedIndex >= 0 && wheel.wheelSelectedIndex < 4);

  const final = await blue.waitFor((state) => state.phase === 'round' && state.roundIndex === 4 && state.prompt);
  assert.equal(final.mode.id, ['word', 'quiz', 'repair', 'relay'][wheel.wheelSelectedIndex]);
  if (final.prompt.kind === 'word') blue.send({ type: 'answer', answer: '윤슬' });
  if (final.prompt.kind === 'quiz') blue.send({ type: 'choice', choice: final.prompt.choices[0] });
  if (final.prompt.kind === 'repair') blue.send({ type: 'answer', answer: '한글날을 맞아 우리말을 사랑해요' });
  if (final.prompt.kind === 'relay') {
    blue.send({ type: 'relayAnswer', answer: final.prompt.prompt });
    white.send({ type: 'relayAnswer', answer: '오답' });
  }
  const result = await blue.waitFor((state) => state.phase === 'results');
  assert.equal(result.winner, 'blue');
  assert.deepEqual(result.roundWins, { blue: 3, white: 2 });
  assert.equal(result.roundScores.length, 5);

  // Ten rope steps must award only this round, not end the whole match.
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
  const words = ['윤슬', '여우비', '너울', '모꼬지', '미리내', '도란도란', '가람', '아람', '마루', '나래', '누리'];
  let quickState = await quickBlue.waitFor((state) => state.phase === 'round' && state.roundIndex === 0);
  for (let index = 0; index < words.length && quickState.phase === 'round'; index += 1) {
    assert.equal(quickState.prompt.id, `word-${index}`);
    quickBlue.send({ type: 'answer', answer: words[index] });
    quickState = await quickBlue.waitFor((state) => state.phase !== 'round' || state.prompt?.id === `word-${index + 1}`);
  }
  assert.equal(quickState.phase, 'intermission');
  assert.equal(quickState.roundScores[0].reason, 'rope');
  assert.deepEqual(quickState.roundWins, { blue: 1, white: 0 });

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
