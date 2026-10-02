import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { WORD_QUIZ_PROMPTS, HANGUL_CREATION_QUIZ_PROMPTS } from '../server/quiz-prompts.js';
import { REPAIR_PROMPTS } from '../server/spacing-prompts.js';
import { AI_LEVELS, getAiAnswerDelay } from '../shared/ai-levels.js';

async function setup(t, port, duration) {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), ROUND_DURATION_MS: String(duration), ROUND_INTRO_MS: '50', INTERMISSION_MS: '100', WHEEL_DURATION_MS: '50', PLACEMENT_MS: '100', TEAM_REVEAL_MS: '50', RELAY_DUEL_PAUSE_MS: '50', OVERTIME_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await once(server.stdout, 'data');
  return async (name, roomId, playMode = 'typing') => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    t.after(() => socket.close());
    let state;
    const pending = new Set();
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'state') state = message;
      for (const check of pending) check(message);
    });
    await once(socket, 'open');
    const client = {
      socket,
      get state() { return state; },
      send(message) { socket.send(JSON.stringify(message)); },
      wait(predicate, timeout = 12_000) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pending.delete(check); reject(new Error(`대기 실패: ${state?.sessionMode}/${state?.phase}/${state?.roundIndex}`)); }, timeout);
          function check(message) {
            if (!predicate(message)) return;
            clearTimeout(timer); pending.delete(check); resolve(message);
          }
          pending.add(check);
        });
      },
      waitState(predicate, timeout) {
        return state && predicate(state) ? Promise.resolve(state) : this.wait((message) => message.type === 'state' && predicate(message), timeout);
      },
      async answer(answer) {
        const result = this.wait((message) => message.type === 'answerResult' || message.type === 'choiceResult' || message.type === 'relayAnswerResult');
        const prompt = state.prompt;
        this.send(prompt.kind === 'quiz' ? { type: 'choice', promptId: prompt.id, choice: answer } : prompt.kind === 'relay' ? { type: 'relayAnswer', answer, deadline: prompt.relayDeadline } : { type: 'answer', answer });
        return result;
      },
    };
    if (name) {
      client.send(roomId ? { type: 'join', roomId, name } : { type: 'createRoom', name, playMode, hostParticipation: 'observe' });
      await client.waitState((state) => state.self);
    }
    return client;
  };
}

function quizAnswer(prompt) {
  return [...WORD_QUIZ_PROMPTS, ...HANGUL_CREATION_QUIZ_PROMPTS].find((entry) => entry.meaning === prompt.meaning && prompt.choices.includes(entry.answer)).answer;
}

test('AI 10단계는 모두 속도·정확도가 구분되며 높은 단계가 더 빨라요', () => {
  assert.equal(AI_LEVELS.length, 10);
  for (const [index, entry] of AI_LEVELS.entries()) {
    assert.equal(entry.level, index + 1);
    assert.ok(entry.accuracy > 0 && entry.accuracy < 1);
    for (const prompt of [{ kind: 'quiz' }, { kind: 'word', word: '아름다운 우리말' }]) {
      const duration = getAiAnswerDelay(entry.level, prompt, () => 0.5);
      assert.ok(duration >= 750);
      if (index) assert.ok(duration < getAiAnswerDelay(index, prompt, () => 0.5));
    }
    if (index) assert.ok(entry.accuracy > AI_LEVELS[index - 1].accuracy);
  }
});

test('대기 모드: 혼자 네 종목·릴레이 연습, 학생 입장·권한 분리, 4→1 반복, 본 경기 전환', async (t) => {
  const connect = await setup(t, 18798, 1_800);
  const host = await connect('선생님');
  const roomId = host.state.roomId;
  host.send({ type: 'startWaiting' });
  let state = await host.waitState((state) => state.sessionMode === 'waiting' && state.phase === 'round');
  assert.equal(state.self.spectator, false);
  assert.equal(state.self.team, 'blue');
  assert.deepEqual(state.counts, { blue: 1, white: 0 });
  assert.equal((await host.answer(state.prompt.word)).correct, true);
  const guest = await connect('학생 1', roomId);
  assert.equal(guest.state.sessionMode, 'waiting');
  assert.equal(guest.state.prompt, null);
  assert.equal(guest.state.self.spectator, true);
  let error = guest.wait((message) => message.type === 'error');
  guest.send({ type: 'startWaiting' });
  assert.match((await error).message, /선생님/);
  error = host.wait((message) => message.type === 'error');
  host.send({ type: 'start' });
  assert.match((await error).message, /두 명/);
  assert.equal(host.state.sessionMode, 'waiting');
  for (const index of [1, 2, 3]) {
    host.send({ type: 'selectWaitingRound', roundIndex: index });
    state = await host.waitState((state) => state.phase === 'round' && state.roundIndex === index);
    const score = state.scores.blue;
    guest.send({ type: 'selectWaitingRound', roundIndex: 0 });
    guest.send({ type: 'answer', answer: state.prompt.word || state.prompt.prompt || '아무 답' });
    guest.send({ type: 'choice', promptId: state.prompt.id, choice: state.prompt.choices?.[0] });
    guest.send({ type: 'relayAnswer', answer: state.prompt.prompt, deadline: state.prompt.relayDeadline });
    await delay(100);
    assert.equal(host.state.roundIndex, index);
    assert.equal(host.state.scores.blue, score);
    const expected = index === 1 ? quizAnswer(state.prompt) : index === 2 ? REPAIR_PROMPTS.find((entry) => entry.question === state.prompt.question).answer : state.prompt.prompt;
    assert.equal((await host.answer(expected)).correct, true);
  }
  await host.waitState((state) => state.phase === 'round' && state.roundIndex === 0);
  assert.equal(host.state.roundScores.length, 0);
  assert.equal(host.state.sessionMode, 'waiting');
  const guest2 = await connect('학생 2', roomId);
  assert.equal(guest2.state.self.spectator, true);
  host.send({ type: 'start' });
  state = await host.waitState((state) => state.sessionMode === 'class' && state.phase === 'round');
  assert.equal(state.self.spectator, true);
  assert.deepEqual(state.counts, { blue: 1, white: 1 });
  assert.deepEqual(state.scores, { blue: 0, white: 0 });
  assert.equal(state.players.filter((entry) => entry.spectator).length, 1);
  assert.equal(state.players.some((entry) => entry.isAI), false);
  assert.ok((await guest.waitState((state) => state.sessionMode === 'class' && state.phase === 'round')).prompt);
});

test('AI 1:1: 10단계 선택 검증·실제 득감점·외부 입장 차단·경기 결과·재도전·설정 복원', async (t) => {
  const connect = await setup(t, 18799, 2_700);
  const host = await connect('AI 도전자', null, 'tablet');
  const roomId = host.state.roomId;
  for (const level of [0, 11, '5', 2.5]) {
    const error = host.wait((message) => message.type === 'error');
    host.send({ type: 'startAI', level });
    assert.match((await error).message, /10단계/);
    assert.equal(host.state.sessionMode, 'class');
  }
  for (let level = 1; level <= 10; level += 1) {
    host.send({ type: 'startAI', level });
    const state = await host.waitState((state) => state.sessionMode === 'ai' && state.aiLevel === level);
    assert.equal(state.players.filter((entry) => entry.isAI).length, 1);
    assert.equal(state.self.team, 'blue');
    assert.equal(state.self.spectator, false);
    assert.deepEqual(state.counts, { blue: 1, white: 1 });
    if (level < 10) {
      host.send({ type: 'restart' });
      await host.waitState((state) => state.sessionMode === 'class');
    }
  }
  const state = await host.waitState((state) => state.phase === 'round');
  const botId = state.players.find((entry) => entry.isAI).id;
  const outside = await connect();
  let error = outside.wait((message) => message.type === 'error');
  outside.send({ type: 'join', roomId, name: '나중 학생' });
  assert.match((await error).message, /AI 1:1/);
  assert.equal((await host.answer(quizAnswer(state.prompt))).correct, true);
  host.send({ type: 'setScoreMultiplier', multiplier: 4 });
  await host.waitState((state) => state.scoreMultiplier === 4);
  const aiAnswer = await host.waitState((state) => state.roundIndex === 0 && state.scores.white !== 0);
  assert.ok(Math.abs(aiAnswer.scores.white) >= 120);
  await host.waitState((state) => state.phase === 'results', 25_000);
  assert.ok(host.state.roundScores.length >= 4);
  host.send({ type: 'startAI', level: 9 });
  const retry = await host.waitState((state) => state.aiLevel === 9 && state.phase !== 'results');
  assert.equal(retry.players.filter((entry) => entry.isAI).length, 1);
  assert.notEqual(retry.players.find((entry) => entry.isAI).id, botId);
  host.send({ type: 'restart' });
  const restored = await host.waitState((state) => state.sessionMode === 'class');
  assert.equal(restored.players.length, 1);
  assert.equal(restored.self.spectator, true);
  assert.equal(restored.hostParticipation, 'observe');
  assert.equal(restored.scoreMultiplier, 4);
  outside.send({ type: 'join', roomId, name: '학생' });
  await outside.waitState((state) => state.self);
  error = host.wait((message) => message.type === 'error');
  host.send({ type: 'startAI', level: 1 });
  assert.match((await error).message, /혼자/);
});

test('AI는 타자·객관식·띄어쓰기·릴레이에서도 실제 답안을 제출해요', async (t) => {
  const connect = await setup(t, 18800, 9_000);
  const host = await connect('타자 도전자');
  host.send({ type: 'startAI', level: 10 });
  for (let index = 0; index < 3; index += 1) {
    const answered = await host.waitState((state) => state.phase === 'round' && state.roundIndex === index && state.scores.white !== 0, 15_000);
    assert.equal(answered.mode.id, ['word', 'quiz', 'repair'][index]);
  }
  const relay = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 3 && state.prompt?.kind === 'relay', 15_000);
  assert.equal((await host.answer(relay.prompt.prompt)).correct, true);
  const aiSubmitted = await host.waitState((state) => state.relay?.whiteSubmitted, 12_000);
  assert.ok(aiSubmitted.relay.lastResult);
  assert.deepEqual(aiSubmitted.counts, { blue: 1, white: 1 });
  const closed = once(host.socket, 'close');
  host.socket.close();
  await closed;
  const outside = await connect();
  const missingRoom = outside.wait((message) => message.type === 'error');
  outside.send({ type: 'join', roomId: relay.roomId, name: '확인' });
  assert.match((await missingRoom).message, /AI 1:1/);
});
