import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { loadSession, saveSession, forgetSession } from '../src/session.js';

test('재입장 정보는 방별로 저장하며 저장소 오류에도 입장을 막지 않는다', () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  const session = { token: 'private-token', name: '학생', characterId: 'bear' };
  saveSession('ABC123', session, storage);
  assert.deepEqual(loadSession('ABC123', storage), session);
  assert.equal(loadSession('OTHER1', storage), null);
  forgetSession('ABC123', storage);
  assert.equal(loadSession('ABC123', storage), null);
  const blocked = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  assert.equal(loadSession('ABC123', blocked), null);
  assert.doesNotThrow(() => saveSession('ABC123', session, blocked));
  assert.doesNotThrow(() => forgetSession('ABC123', blocked));
});

test('경기 중 입장·만원 재접속·점수/문제 복구·선생님 새로고침·빈방 보관', { timeout: 30_000 }, async (t) => {
  const portFinder = createServer();
  portFinder.listen(0, '127.0.0.1');
  await once(portFinder, 'listening');
  const port = portFinder.address().port;
  await new Promise((resolve) => portFinder.close(resolve));
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), MAX_ROOMS: '2', PLACEMENT_MS: '100', TEAM_REVEAL_MS: '100', ROUND_INTRO_MS: '0', ROUND_DURATION_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await once(server.stdout, 'data');
  const clients = [];
  async function connect(message) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?delta=1`);
    let state;
    const messages = [];
    const pending = new Set();
    const client = {
      socket, get state() { return state; }, messages,
      send: (m) => socket.send(JSON.stringify(m)),
      wait(predicate) {
        const existing = messages.findLast(predicate);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(check); reject(Error('접속 상태 대기 실패')); }, 5000);
          function check(m) { if (predicate(m)) { clearTimeout(timer); pending.delete(check); resolve(m); } }
          pending.add(check);
        });
      },
      waitState(predicate) {
        if (state && predicate(state)) return Promise.resolve(state);
        return this.wait((m) => m.type === 'state' && predicate(m));
      },
    };
    socket.on('message', (raw) => {
      let m = JSON.parse(raw);
      if (m.type === 'state') { state = m.full === false ? { ...state, ...m } : m; m = state; }
      messages.push(m);
      for (const check of pending) check(m);
    });
    clients.push(client);
    t.after(() => socket.terminate());
    await once(socket, 'open');
    if (message) {
      client.send(message);
      client.joined = await client.wait((m) => m.type === 'joined');
      await client.waitState((s) => s.self);
    }
    return client;
  }
  async function close(client) {
    if (client.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(client.socket, 'close');
    client.socket.close();
    await closed;
  }
  const host = await connect({ type: 'createRoom', name: '선생님', playMode: 'typing', hostParticipation: 'observe' });
  const roomId = host.state.roomId;
  const a = await connect({ type: 'join', roomId, name: '학생1', characterId: 'cat' });
  await connect({ type: 'join', roomId, name: '학생2' });
  host.send({ type: 'start' });
  await a.waitState((s) => s.phase === 'round');
  const late = await connect({ type: 'join', roomId, name: '늦은학생' });
  assert.equal(late.state.phase, 'round');
  assert.ok(late.state.prompt);
  assert.equal(late.state.counts.blue + late.state.counts.white, 3);
  const id = a.state.self.id;
  const team = a.state.self.team;
  const previousPrompt = a.state.prompt.id;
  a.send({ type: 'answer', answer: a.state.prompt.word });
  assert.equal((await a.wait((m) => m.type === 'answerResult')).correct, true);
  await a.waitState((s) => s.prompt.id !== previousPrompt && s.players.find((p) => p.id === id).scoreCount > 0);
  const nextPrompt = a.state.prompt.id;
  const scoreCount = a.state.players.find((p) => p.id === id).scoreCount;
  // 재접속은 새 참가자 제한과 별개로 허용합니다.
  for (let i = 0; i < 27; i++) await connect({ type: 'join', roomId, name: `추가${i}` });
  const outside = await connect();
  outside.send({ type: 'join', roomId, name: '초과' });
  assert.match((await outside.wait((m) => m.type === 'error')).message, /30명/);
  outside.send({ type: 'resume', roomId, token: 'invalid' });
  assert.ok(await outside.wait((m) => m.type === 'resumeFailed'));
  const otherRoom = await connect({ type: 'createRoom', name: '다른선생님' });
  const messageStart = outside.messages.length;
  outside.send({ type: 'resume', roomId: otherRoom.state.roomId, token: a.joined.token });
  assert.ok(await outside.wait((m) => m.type === 'resumeFailed' && outside.messages.indexOf(m) >= messageStart));
  outside.send({ type: 'createRoom', name: '초과방' });
  assert.match((await outside.wait((m) => m.type === 'error' && /방이 많/.test(m.message))).message, /방이 많/);
  await close(a);
  await host.waitState((s) => s.players.find((p) => p.id === id)?.connected === false);
  const restored = await connect({ type: 'resume', roomId, token: a.joined.token });
  assert.equal(restored.joined.resumed, true);
  assert.equal(restored.state.self.id, id);
  assert.equal(restored.state.self.team, team);
  assert.equal(restored.state.self.characterId, 'cat');
  assert.equal(restored.state.prompt.id, nextPrompt);
  assert.equal(restored.state.players.find((p) => p.id === id).scoreCount, scoreCount);
  assert.equal(restored.state.players.filter((p) => !p.isHost).length, 30);
  assert.equal(restored.messages.find((m) => m.type === 'state').full, true);
  assert.equal(JSON.stringify(restored.state).includes(a.joined.token), false);
  // 이전 소켓의 지연된 close가 새 연결을 끊거나 참가 기록을 지우면 안 됩니다.
  const replaced = once(restored.socket, 'close');
  const replacement = await connect({ type: 'resume', roomId, token: a.joined.token });
  await replaced;
  assert.equal(replacement.state.self.id, id);
  await close(host);
  const teacher = await connect({ type: 'resume', roomId, token: host.joined.token });
  assert.equal(teacher.state.self.id, host.joined.player.id);
  assert.equal(teacher.state.self.isHost, true);
  assert.equal(teacher.state.phase, 'round');
  await Promise.all(clients.map(close));
  const lastReturn = await connect({ type: 'resume', roomId, token: host.joined.token });
  assert.equal(lastReturn.state.self.isHost, true);
  assert.equal(lastReturn.state.players.find((p) => p.id === id).scoreCount, scoreCount);
});
