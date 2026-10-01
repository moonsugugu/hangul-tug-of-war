import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { WORD_QUIZ_PROMPTS, HANGUL_CREATION_QUIZ_PROMPTS } from '../server/quiz-prompts.js';
import { REPAIR_PROMPTS } from '../server/spacing-prompts.js';
import { ANSWER_REVIEW_MS, SCORE_MULTIPLIER_LEVELS } from '../shared/score-settings.js';

function watch(socket) {
  let state;
  const listeners = new Set();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'state') state = message;
    for (const check of listeners) check(message);
  });
  return {
    get state() { return state; },
    send(message) { socket.send(JSON.stringify(message)); },
    wait(predicate, timeout = 8_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`응답 대기 실패: ${state?.phase}/${state?.roundIndex}`)); }, timeout);
        function check(message) {
          if (!predicate(message)) return;
          clearTimeout(timer); listeners.delete(check); resolve(message);
        }
        listeners.add(check);
      });
    },
    waitState(predicate) {
      return state && predicate(state) ? Promise.resolve(state) : this.wait((message) => message.type === 'state' && predicate(message));
    },
    async setMultiplier(multiplier) {
      const changed = this.waitState((state) => state.scoreMultiplier === multiplier);
      this.send({ type: 'setScoreMultiplier', multiplier });
      return changed;
    },
    async choose(choice) {
      const current = state;
      const result = this.wait((message) => message.type === 'choiceResult');
      const next = this.waitState((state) => state.prompt?.id !== current.prompt.id);
      this.send({ type: 'choice', promptId: current.prompt.id, choice });
      return { result: await result, next: await next };
    },
  };
}

async function setup(t, port, duration) {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), ROUND_DURATION_MS: String(duration), ROUND_INTRO_MS: '50', INTERMISSION_MS: '50', PLACEMENT_MS: '50', TEAM_REVEAL_MS: '50', RELAY_DUEL_PAUSE_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    let diagnostics = '';
    server.stderr.on('data', (data) => { diagnostics += data; });
    const timer = setTimeout(() => reject(new Error('서버 시작 실패')), 5_000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', () => { clearTimeout(timer); reject(new Error(`서버 시작 실패: ${diagnostics}`)); });
  });
  return async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    t.after(() => socket.close());
    const client = watch(socket);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return client;
  };
}

function quizAnswer(prompt) {
  return [...WORD_QUIZ_PROMPTS, ...HANGUL_CREATION_QUIZ_PROMPTS].find((entry) => entry.meaning === prompt.meaning && prompt.choices.includes(entry.answer)).answer;
}
function approximately(actual, expected) { assert.ok(Math.abs(actual - expected) < 0.001, `${actual} ≠ ${expected}`); }

test('7단계 배율: 방장 권한·숫자 검증·방 분리·변경 이후 득감점·3초 복습', async (t) => {
  const connect = await setup(t, 18791, 6_000);
  const host = await connect();
  host.send({ type: 'createRoom', name: '배율 선생님', playMode: 'tablet' });
  const lobby = await host.waitState((state) => state.self);
  assert.equal(lobby.scoreMultiplier, 1);
  const guest = await connect();
  guest.send({ type: 'join', name: '학생', roomId: lobby.roomId });
  await guest.waitState((state) => state.self);
  const other = await connect();
  other.send({ type: 'createRoom', name: '다른 방', playMode: 'tablet' });
  await other.waitState((state) => state.self);
  let rejection = host.wait((message) => message.type === 'error');
  host.send({ type: 'setScoreMultiplier', multiplier: 2 });
  assert.match((await rejection).message, /경기 화면/);
  host.send({ type: 'start' });
  const round = await host.waitState((state) => state.phase === 'round');
  const team = round.self.team;
  const originalPrompt = round.prompt;
  rejection = guest.wait((message) => message.type === 'error');
  guest.send({ type: 'setScoreMultiplier', multiplier: 7 });
  assert.match((await rejection).message, /방장/);
  for (const invalid of [0, 8, 1.5, '3', null, true]) {
    rejection = host.wait((message) => message.type === 'error');
    host.send({ type: 'setScoreMultiplier', multiplier: invalid });
    assert.match((await rejection).message, /1배부터 7배/);
  }
  for (const level of SCORE_MULTIPLIER_LEVELS) {
    const changed = await host.setMultiplier(level);
    await guest.waitState((state) => state.scoreMultiplier === level);
    assert.deepEqual(changed.prompt, originalPrompt, '배율 변경은 문제·보기 순서를 바꾸지 않아요');
    assert.deepEqual(changed.scores, { blue: 0, white: 0 });
  }
  assert.equal(other.state.scoreMultiplier, 1);
  await host.setMultiplier(2);
  const correct = await host.choose(quizAnswer(host.state.prompt));
  assert.equal(correct.result.scoreMultiplier, 2);
  const previousScore = correct.next.scores[team];
  approximately(previousScore, correct.result.score * 2);
  const changed = await host.setMultiplier(7);
  assert.equal(changed.scores[team], previousScore, '기존 점수는 재계산하지 않아요');
  const wrongChoice = changed.prompt.choices.find((choice) => choice !== quizAnswer(changed.prompt));
  const wrong = await host.choose(wrongChoice);
  assert.equal(wrong.result.submittedAnswer, wrongChoice);
  assert.ok(wrong.result.explanation);
  approximately(wrong.next.scores[team], previousScore - 210);
  const nextPromptId = wrong.next.prompt.id;
  host.send({ type: 'choice', promptId: nextPromptId, choice: quizAnswer(wrong.next.prompt) });
  await delay(100);
  assert.equal(host.state.prompt.id, nextPromptId, '팝업 중 제출은 서버가 차단해요');
  await delay(ANSWER_REVIEW_MS);
  const fast = await host.choose(quizAnswer(host.state.prompt));
  assert.ok(fast.result.score > 95, '3초 복습은 다음 정답의 속도 보너스에서 제외해요');
  approximately(fast.next.scores[team], previousScore - 210 + fast.result.score * 7);
  const guestCorrect = await guest.choose(quizAnswer(guest.state.prompt));
  approximately(guestCorrect.next.scores[guestCorrect.next.self.team], guestCorrect.result.score * 7);
  await host.waitState((state) => state.phase === 'intermission');
  await host.setMultiplier(4);
  const nextRound = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 1);
  assert.equal(nextRound.scoreMultiplier, 4);
  assert.deepEqual(nextRound.scores, { blue: 0, white: 0 });
  host.send({ type: 'restart' });
  const restarted = await host.waitState((state) => state.phase === 'lobby');
  assert.equal(restarted.scoreMultiplier, 4, '새 게임에도 선생님 배율을 유지해요');
});

test('배율은 타자·시간 종료 부분 점수·릴레이 대표/응원에도 적용해요', async (t) => {
  const connect = await setup(t, 18793, 1_800);
  const host = await connect();
  host.send({ type: 'createRoom', name: '타자 선생님' });
  const lobby = await host.waitState((state) => state.self);
  const clients = [host];
  for (let i = 0; i < 3; i++) {
    const guest = await connect();
    guest.send({ type: 'join', name: `타자 학생${i}`, roomId: lobby.roomId });
    await guest.waitState((state) => state.self);
    clients.push(guest);
  }
  host.send({ type: 'start' });
  const first = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 0);
  await host.setMultiplier(3);
  const typedResult = host.wait((message) => message.type === 'answerResult');
  host.send({ type: 'answer', answer: first.prompt.word });
  const typed = await typedResult;
  assert.equal(typed.scoreMultiplier, 3);
  await host.waitState((state) => state.prompt.id !== first.prompt.id);
  approximately(host.state.scores[first.self.team], typed.score * 3);
  const draftClient = clients.find((client) => client !== host && client.state.self.team !== first.self.team);
  const timeout = draftClient.wait((message) => message.type === 'timeoutScore');
  draftClient.send({ type: 'draft', promptId: draftClient.state.prompt.id, text: draftClient.state.prompt.word.slice(0, 1) });
  const timed = await timeout;
  assert.equal(timed.scoreMultiplier, 3);
  const firstResult = await host.waitState((state) => state.phase === 'intermission');
  approximately(firstResult.scores[draftClient.state.self.team], timed.score * 3);
  const quiz = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 1);
  await host.choose(quizAnswer(quiz.prompt));
  const repair = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 2);
  const repairResult = host.wait((message) => message.type === 'answerResult');
  host.send({ type: 'answer', answer: REPAIR_PROMPTS.find((entry) => entry.question === repair.prompt.question).answer });
  const repaired = await repairResult;
  await host.waitState((state) => state.prompt.id !== repair.prompt.id);
  approximately(host.state.scores[repair.self.team], repaired.score * 1.3 * 3);
  const relay = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 3);
  await host.setMultiplier(7);
  await Promise.all(clients.map((client) => client.waitState((state) => state.scoreMultiplier === 7 && state.phase === 'round' && state.roundIndex === 3)));
  const representative = clients.find((client) => client.state.prompt.selected);
  const supporter = clients.find((client) => client.state.self.team === representative.state.self.team && !client.state.prompt.selected);
  let feedback = representative.wait((message) => message.type === 'relayAnswerResult');
  representative.send({ type: 'relayAnswer', deadline: relay.relay.deadline, answer: relay.prompt.prompt });
  assert.equal((await feedback).scoreMultiplier, 7);
  await host.waitState((state) => state.scores[representative.state.self.team] === 1_050);
  await host.setMultiplier(2);
  feedback = supporter.wait((message) => message.type === 'relayAnswerResult');
  supporter.send({ type: 'relayAnswer', deadline: relay.relay.deadline, answer: relay.prompt.prompt });
  assert.equal((await feedback).scoreMultiplier, 2);
  const supported = await host.waitState((state) => state.scores[representative.state.self.team] === 1_052);
  assert.equal(supported.phase, 'round', '배율이 커져도 릴레이는 시간까지 진행해요');
});
