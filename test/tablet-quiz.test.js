import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { WORD_QUIZ_PROMPTS, HANGUL_CREATION_QUIZ_PROMPTS } from '../server/quiz-prompts.js';
import { ANSWER_REVIEW_MS } from '../shared/score-settings.js';

const PORT = 18788;
const questions = [...WORD_QUIZ_PROMPTS, ...HANGUL_CREATION_QUIZ_PROMPTS];
function answerFor(prompt) {
  const source = questions.find((entry) => entry.meaning === prompt.meaning && prompt.choices.includes(entry.answer));
  assert.ok(source, '출제된 문제에 정답이 있어야 해요');
  return source.answer;
}

function watch(socket) {
  const messages = [];
  let state;
  const listeners = new Set();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    if (message.type === 'state') state = message;
    for (const listener of listeners) listener(message);
  });
  return {
    send(message) { socket.send(JSON.stringify(message)); },
    get state() { return state; },
    get messages() { return messages; },
    wait(predicate, timeout = 9_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`대기 실패: ${state?.phase}, ${state?.roundIndex}`)); }, timeout);
        function check(message) {
          if (!predicate(message)) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(message);
        }
        listeners.add(check);
      });
    },
    waitState(predicate) {
      if (state && predicate(state)) return Promise.resolve(state);
      return this.wait((message) => message.type === 'state' && predicate(message));
    },
  };
}

test('태블릿 객관식: 타자 없이 4라운드와 결승, 감점·속도 보너스·중복 방지', async (t) => {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), ROUND_DURATION_MS: '6500', ROUND_INTRO_MS: '100', INTERMISSION_MS: '100', WHEEL_DURATION_MS: '100', TEAM_REVEAL_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('시험 서버 시작 실패')), 5_000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', reject);
  });
  const sockets = [];
  t.after(() => sockets.forEach((socket) => socket.close()));
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    sockets.push(socket);
    const client = watch(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return client;
  }
  const host = await connect();
  const guest = await connect();
  host.send({ type: 'createRoom', name: '태블릿 진행', playMode: 'tablet' });
  const lobby = await host.waitState((state) => state.self && state.phase === 'lobby');
  assert.equal(lobby.playMode, 'tablet');
  assert.equal(lobby.prompt, null, '대기실에서도 타자를 요구하지 않아요');
  assert.equal(lobby.roundModes.length, 4);
  assert.ok(lobby.roundModes.every((mode) => mode.id === 'quiz'));
  guest.send({ type: 'join', roomId: lobby.roomId, name: '태블릿 참가', playMode: 'typing' });
  const guestLobby = await guest.waitState((state) => state.self);
  assert.equal(guestLobby.playMode, 'tablet', '입장자가 방 모드를 바꿀 수 없어요');
  host.send({ type: 'start' });
  const reveal = await host.waitState((state) => state.phase === 'teamReveal');
  assert.equal(reveal.self.typingSpeed, null);
  assert.deepEqual(reveal.counts, { blue: 1, white: 1 });

  let current = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 0);
  const team = current.self.team;
  assert.equal(current.prompt.kind, 'quiz');
  assert.equal(current.prompt.choices.length, 4);
  assert.equal(new Set(current.prompt.choices).size, 4);
  assert.equal('answer' in current.prompt, false, '정답은 미리 공개하지 않아요');
  const originalId = current.prompt.id;
  const originalChoices = [...current.prompt.choices];
  host.send({ type: 'answer', answer: answerFor(current.prompt) });
  host.send({ type: 'choice', promptId: originalId, choice: '보기 밖의 답' });
  host.send({ type: 'choice', choice: originalChoices[0] });
  const unchanged = await host.wait((message) => message.type === 'state');
  assert.equal(unchanged.prompt.id, originalId);
  assert.deepEqual(unchanged.prompt.choices, originalChoices, '방 상태 갱신 때 보기가 바뀌지 않아요');
  assert.equal(unchanged.scores[team], 0);

  async function choose(client, state, choice, duplicate = false) {
    const result = client.wait((message) => message.type === 'choiceResult');
    const next = client.waitState((message) => message.phase !== 'round' || message.prompt?.id !== state.prompt.id);
    const request = { type: 'choice', promptId: state.prompt.id, choice };
    client.send(request);
    if (duplicate) client.send(request);
    return { result: await result, next: await next };
  }
  const wrong = originalChoices.find((choice) => choice !== answerFor(current.prompt));
  let submitted = await choose(host, current, wrong, true);
  assert.equal(submitted.result.correct, false);
  assert.equal(submitted.result.score, -30);
  assert.equal(submitted.result.submittedAnswer, wrong);
  assert.ok(submitted.result.explanation, '오답 팝업에 문제 해설을 제공해요');
  assert.equal(submitted.next.scores[team], -30, '0점에서도 실제 감점해요');
  const resultCount = host.messages.filter((message) => message.type === 'choiceResult').length;
  current = submitted.next;
  const duplicateCheck = await host.wait((message) => message.type === 'state');
  assert.equal(duplicateCheck.prompt.id, current.prompt.id);
  assert.equal(host.messages.filter((message) => message.type === 'choiceResult').length, resultCount, '연속 터치는 한 번만 채점해요');
  host.send({ type: 'choice', promptId: current.prompt.id, choice: answerFor(current.prompt) });
  await delay(100);
  assert.equal(host.messages.filter((message) => message.type === 'choiceResult').length, resultCount, '3초 복습 중에는 다음 답안을 채점하지 않아요');
  await delay(ANSWER_REVIEW_MS);

  submitted = await choose(host, current, answerFor(current.prompt));
  const fastScore = submitted.result.score;
  assert.ok(fastScore > 90 && fastScore <= 100);
  current = submitted.next;
  await delay(1_000);
  submitted = await choose(host, current, answerFor(current.prompt));
  assert.ok(submitted.result.score >= 60 && submitted.result.score <= 95 && submitted.result.score < fastScore, '늦은 정답의 보너스가 더 작아요');
  assert.ok(Math.abs(submitted.next.scores[team] - (-30 + fastScore + submitted.result.score)) < 0.001);
  await host.waitState((state) => state.phase === 'intermission' && state.roundIndex === 0);

  // Alternate winners so the fifth-round wheel is exercised in tablet mode too.
  for (let index = 1; index <= 3; index += 1) {
    const winner = index % 2 === 1 ? guest : host;
    const round = await winner.waitState((state) => state.phase === 'round' && state.roundIndex === index);
    assert.equal(round.prompt.kind, 'quiz');
    assert.equal(round.prompt.choices.length, 4);
    assert.equal(new Set(round.prompt.choices).size, 4);
    assert.equal(round.mode.id, 'quiz');
    await choose(winner, round, answerFor(round.prompt));
    await host.waitState((state) => state.roundIndex === index && ['intermission', 'wheel'].includes(state.phase));
  }
  const wheel = await host.waitState((state) => state.phase === 'wheel');
  assert.deepEqual(wheel.roundWins, { blue: 2, white: 2 });
  const final = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 4);
  assert.equal(final.prompt.kind, 'quiz');
  assert.equal(final.prompt.choices.length, 4);
  assert.equal(final.mode.name, lobby.roundModes[wheel.wheelSelectedIndex].name);
  await choose(host, final, answerFor(final.prompt));
  const finished = await host.waitState((state) => state.phase === 'results');
  assert.equal(finished.winner, team);
  assert.equal(finished.roundScores.length, 5);
  assert.equal(host.messages.some((message) => message.type === 'state' && message.phase === 'placement'), false);
  host.send({ type: 'restart' });
  const restarted = await host.waitState((state) => state.phase === 'lobby');
  assert.equal(restarted.playMode, 'tablet');
  assert.equal(restarted.prompt, null);

  // Existing clients omit playMode; their rooms keep the original typing flow.
  const typing = await connect();
  typing.send({ type: 'createRoom', name: '기존 모드' });
  const typingLobby = await typing.waitState((state) => state.self);
  assert.equal(typingLobby.playMode, 'typing');
  assert.equal(typingLobby.prompt.kind, 'practice');
  assert.deepEqual(typingLobby.roundModes.map((mode) => mode.id), ['word', 'quiz', 'repair', 'relay']);

  // An odd roster still has balanced teams and uses the existing headcount bonus.
  const oddHost = await connect();
  oddHost.send({ type: 'createRoom', name: '다섯 명 방장', playMode: 'tablet' });
  const oddLobby = await oddHost.waitState((state) => state.self);
  for (let index = 0; index < 4; index += 1) {
    const player = await connect();
    player.send({ type: 'join', roomId: oddLobby.roomId, name: `참가자${index}` });
    await player.waitState((state) => state.self);
  }
  oddHost.send({ type: 'start' });
  const oddReveal = await oddHost.waitState((state) => state.phase === 'teamReveal');
  assert.deepEqual(oddReveal.counts, { blue: 3, white: 2 });
  assert.deepEqual(oddReveal.multipliers, { blue: 1, white: 1.5 });
  const oddRound = await oddHost.waitState((state) => state.phase === 'round');
  const oddAnswer = await choose(oddHost, oddRound, answerFor(oddRound.prompt));
  assert.ok(Math.abs(oddAnswer.next.scores[oddRound.self.team] - oddAnswer.result.score * oddRound.multipliers[oddRound.self.team]) < 0.001);

  const invalid = await connect();
  const error = invalid.wait((message) => message.type === 'error');
  invalid.send({ type: 'createRoom', name: '잘못된 모드', playMode: 'unknown' });
  assert.match((await error).message, /방 모드/);
});

test('객관식 문제 은행에는 정답 하나와 서로 다른 보기 4개가 있어요', () => {
  for (const question of questions) {
    assert.equal(question.choices.length, 4);
    assert.equal(new Set(question.choices).size, 4);
    assert.equal(question.choices.filter((choice) => choice === question.answer).length, 1);
  }
});
