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

async function setup(t, port, duration, timing = {}) {
  const env = { ...process.env, PORT: String(port), ROUND_DURATION_MS: String(duration), ROUND_INTRO_MS: '50', INTERMISSION_MS: '50', WHEEL_DURATION_MS: '50', PLACEMENT_MS: '100', TEAM_REVEAL_MS: '50', RELAY_DUEL_PAUSE_MS: '50' };
  for (const [key, value] of Object.entries(timing)) {
    if (value === null) delete env[key];
    else env[key] = String(value);
  }
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env,
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

async function addStudents(connect, roomId, count = 2) {
  const clients = [];
  for (let index = 0; index < count; index++) {
    const client = await connect();
    client.send({ type: 'join', roomId, name: `학생${index + 1}` });
    await client.waitState((state) => state.self);
    clients.push(client);
  }
  return clients;
}

test('진행만 하는 선생님이 양 팀 학생 전체의 배율을 바꾸며 4라운드·결승을 진행해요', async (t) => {
  const connect = await setup(t, 18794, 1_400);
  const host = await connect();
  host.send({ type: 'createRoom', name: '진행 선생님', playMode: 'tablet', hostParticipation: 'observe' });
  const lobby = await host.waitState((state) => state.self);
  assert.equal(lobby.self.spectator, true);
  assert.equal(lobby.self.team, null);
  assert.equal(lobby.prompt, null);
  const students = await addStudents(connect, lobby.roomId, 1);
  let error = host.wait((message) => message.type === 'error');
  host.send({ type: 'start' });
  assert.match((await error).message, /두 명 이상/);
  students.push(...await addStudents(connect, lobby.roomId, 1));
  error = students[0].wait((message) => message.type === 'error');
  students[0].send({ type: 'setHostParticipation', participation: 'blue' });
  assert.match((await error).message, /방장/);
  error = host.wait((message) => message.type === 'error');
  host.send({ type: 'setHostParticipation', participation: 'invalid' });
  assert.match((await error).message, /다시 선택/);
  host.send({ type: 'start' });
  const round = await host.waitState((state) => state.phase === 'round');
  assert.deepEqual(round.counts, { blue: 1, white: 1 }, '선생님을 팀 인원에서 제외해요');
  assert.deepEqual(round.multipliers, { blue: 1, white: 1 });
  assert.equal(round.prompt, null);
  await Promise.all(students.map((client) => client.waitState((state) => state.phase === 'round')));
  host.send({ type: 'choice', promptId: students[0].state.prompt.id, choice: quizAnswer(students[0].state.prompt) });
  host.send({ type: 'answer', answer: '몰래 참가' });
  host.send({ type: 'draft', promptId: students[0].state.prompt.id, text: '몰래 참가' });
  await host.setMultiplier(3);
  assert.deepEqual(host.state.scores, { blue: 0, white: 0 }, '진행자는 답안을 보내도 점수를 얻지 못해요');
  for (const student of students) {
    await student.waitState((state) => state.scoreMultiplier === 3);
    const answer = await student.choose(quizAnswer(student.state.prompt));
    approximately(answer.next.scores[answer.next.self.team], answer.result.score * 3);
    assert.equal(answer.result.scoreMultiplier, 3, '양 팀 학생 모두 전체 배율로 채점해요');
  }
  await host.waitState((state) => state.scores.blue > 0 && state.scores.white > 0);
  const previous = { ...host.state.scores };
  await host.setMultiplier(7);
  await students[0].waitState((state) => state.scoreMultiplier === 7);
  assert.deepEqual(host.state.scores, previous);
  const fast = await students[0].choose(quizAnswer(students[0].state.prompt));
  approximately(fast.next.scores[fast.next.self.team], previous[fast.next.self.team] + fast.result.score * 7);
  error = host.wait((message) => message.type === 'error');
  host.send({ type: 'setHostParticipation', participation: 'blue' });
  assert.match((await error).message, /시작 전/);
  await host.waitState((state) => state.phase === 'intermission' && state.roundIndex === 0);
  for (let index = 1; index < 4; index++) {
    const winner = students[index % 2];
    await winner.waitState((state) => state.phase === 'round' && state.roundIndex === index);
    await winner.choose(quizAnswer(winner.state.prompt));
    const finished = await host.waitState((state) => state.roundIndex === index && ['intermission', 'wheel'].includes(state.phase));
    assert.equal(finished.self.team, null);
    assert.equal(finished.prompt, null);
  }
  await students[0].waitState((state) => state.phase === 'round' && state.roundIndex === 4);
  await students[0].choose(quizAnswer(students[0].state.prompt));
  const results = await host.waitState((state) => state.phase === 'results');
  assert.equal(results.roundScores.length, 5);
  host.send({ type: 'restart' });
  const restarted = await host.waitState((state) => state.phase === 'lobby');
  assert.equal(restarted.hostParticipation, 'observe');
  assert.equal(restarted.self.spectator, true);
  assert.equal(restarted.self.team, null);
  assert.equal(restarted.scoreMultiplier, 7);
});

test('선생님은 청팀·백팀을 선택해 참가하거나 자동 배정·진행만으로 바꿀 수 있어요', async (t) => {
  const connect = await setup(t, 18795, 1_600);
  for (const playMode of ['tablet', 'typing']) {
    for (const team of ['blue', 'white']) {
      const host = await connect();
      host.send({ type: 'createRoom', name: '참가 선생님', playMode, hostParticipation: 'observe' });
      const lobby = await host.waitState((state) => state.self);
      await addStudents(connect, lobby.roomId);
      host.send({ type: 'setHostParticipation', participation: team });
      const playingLobby = await host.waitState((state) => state.hostParticipation === team);
      assert.equal(playingLobby.self.spectator, false);
      assert.equal(playingLobby.self.team, team);
      host.send({ type: 'start' });
      const round = await host.waitState((state) => state.phase === 'round');
      assert.equal(round.self.team, team);
      assert.ok(round.prompt);
      assert.equal(round.counts.blue + round.counts.white, 3);
      assert.equal(Math.abs(round.counts.blue - round.counts.white), 1, '팀을 지정해도 인원 배정은 균형을 맞춰요');
      host.send({ type: 'restart' });
      const restarted = await host.waitState((state) => state.phase === 'lobby');
      assert.equal(restarted.hostParticipation, team);
      host.send({ type: 'setHostParticipation', participation: 'auto' });
      const auto = await host.waitState((state) => state.hostParticipation === 'auto');
      assert.equal(auto.self.spectator, false);
      host.send({ type: 'setHostParticipation', participation: 'observe' });
      const observing = await host.waitState((state) => state.hostParticipation === 'observe');
      assert.equal(observing.self.spectator, true);
      assert.equal(observing.self.team, null);
      assert.equal(observing.prompt, null);
    }
  }
});

test('진행 선생님은 타자 테스트와 릴레이 대표 선정에서도 제외해요', async (t) => {
  const connect = await setup(t, 18796, 1_200);
  const host = await connect();
  host.send({ type: 'createRoom', name: '미참가 선생님', hostParticipation: 'observe' });
  const lobby = await host.waitState((state) => state.self);
  const students = await addStudents(connect, lobby.roomId);
  host.send({ type: 'start' });
  const placement = await host.waitState((state) => state.phase === 'placement');
  assert.equal(placement.prompt, null);
  host.send({ type: 'answer', answer: '타자 실력 조작' });
  await students[0].waitState((state) => state.phase === 'round' && state.roundIndex === 0);
  await host.setMultiplier(4);
  await students[0].waitState((state) => state.scoreMultiplier === 4);
  let feedback = students[0].wait((message) => message.type === 'answerResult');
  students[0].send({ type: 'answer', answer: students[0].state.prompt.word });
  assert.equal((await feedback).scoreMultiplier, 4);
  const first = await host.waitState((state) => state.phase === 'intermission');
  assert.equal(first.self.typingSpeed, null);
  assert.equal(first.self.placementKeystrokes, 0);
  await students[1].waitState((state) => state.phase === 'round' && state.roundIndex === 1);
  await students[1].choose(quizAnswer(students[1].state.prompt));
  const repair = await students[0].waitState((state) => state.phase === 'round' && state.roundIndex === 2);
  feedback = students[0].wait((message) => message.type === 'answerResult');
  students[0].send({ type: 'answer', answer: REPAIR_PROMPTS.find((entry) => entry.question === repair.prompt.question).answer });
  await feedback;
  const relay = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 3);
  assert.notEqual(relay.relay.blueId, relay.self.id);
  assert.notEqual(relay.relay.whiteId, relay.self.id);
  assert.equal(relay.prompt, null);
  host.send({ type: 'relayAnswer', deadline: relay.relay.deadline, answer: relay.relay.prompt });
  for (const student of students) {
    await student.waitState((state) => state.phase === 'round' && state.roundIndex === 3);
    feedback = student.wait((message) => message.type === 'relayAnswerResult');
    student.send({ type: 'relayAnswer', deadline: relay.relay.deadline, answer: relay.relay.prompt });
    assert.equal((await feedback).scoreMultiplier, 4);
  }
  const duel = await host.waitState((state) => Boolean(state.relay?.lastResult));
  assert.deepEqual(duel.scores, { blue: 600, white: 600 });
  assert.equal(duel.self.spectator, true);
  assert.ok(duel.players.find((player) => player.isHost).scoreCount === 0);
});

test('설명 대기는 기본 15초, 선생님만 즉시 시작·중복 방지·시간 종료 자동 시작', async (t) => {
  const connect = await setup(t, 18797, 800, { ROUND_INTRO_MS: null, INTERMISSION_MS: null });
  const host = await connect();
  host.send({ type: 'createRoom', name: '라운드 진행 선생님', playMode: 'tablet', hostParticipation: 'observe' });
  const lobby = await host.waitState((state) => state.self);
  const students = await addStudents(connect, lobby.roomId);
  host.send({ type: 'start' });
  const intro = await host.waitState((state) => state.phase === 'roundIntro');
  assert.equal(intro.roundIntroDurationMs, 15_000);
  assert.ok(intro.roundIntroRemainingMs > 14_000);
  let error = students[0].wait((message) => message.type === 'error');
  students[0].send({ type: 'advanceRound', phase: intro.phase, roundIndex: intro.roundIndex });
  assert.match((await error).message, /방장/);
  const firstRequest = { type: 'advanceRound', phase: intro.phase, roundIndex: intro.roundIndex };
  host.send(firstRequest);
  host.send(firstRequest);
  await students[0].waitState((state) => state.phase === 'round' && state.roundIndex === 0);
  await students[0].choose(quizAnswer(students[0].state.prompt));
  const firstBreak = await host.waitState((state) => state.phase === 'intermission' && state.roundIndex === 0);
  assert.equal(firstBreak.intermissionDurationMs, 15_000);
  assert.ok(firstBreak.intermissionRemainingMs > 14_000);
  assert.equal(firstBreak.roundModes[1].name, '한글 창제 원리');
  error = students[0].wait((message) => message.type === 'error');
  students[0].send({ type: 'advanceRound', phase: firstBreak.phase, roundIndex: firstBreak.roundIndex });
  assert.match((await error).message, /방장/);
  const breakRequest = { type: 'advanceRound', phase: firstBreak.phase, roundIndex: firstBreak.roundIndex };
  const advancedAt = Date.now();
  host.send(breakRequest);
  host.send(breakRequest);
  await students[1].waitState((state) => state.phase === 'round' && state.roundIndex === 1);
  assert.ok(Date.now() - advancedAt < 1_000, '추가 대기 없이 다음 라운드를 바로 시작해요');
  await students[1].choose(quizAnswer(students[1].state.prompt));
  const secondBreak = await host.waitState((state) => state.phase === 'intermission' && state.roundIndex === 1);
  const waitingStartedAt = Date.now();
  host.send(breakRequest);
  const waiting = await host.wait((message) => message.type === 'state');
  assert.equal(waiting.phase, 'intermission', '이전 라운드의 늦은 클릭은 다음 대기를 건너뛰지 못해요');
  assert.equal(waiting.roundIndex, 1);
  const started = await host.wait((message) => message.type === 'state' && message.phase === 'round' && message.roundIndex === 2, 17_000);
  assert.ok(Date.now() - waitingStartedAt >= 14_000, '설명을 읽을 15초 대기를 보장해요');
  assert.ok(secondBreak.intermissionRemainingMs > 14_000);
  assert.equal(started.mode.name, '세종대왕 이야기');
  assert.deepEqual(started.scores, { blue: 0, white: 0 });
});
