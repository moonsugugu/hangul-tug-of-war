import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { parseQuestionCsv } from '../shared/question-csv.js';

const PORT = 18790;
function watch(socket) {
  let state;
  const listeners = new Set();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'state') state = message;
    for (const listener of listeners) listener(message);
  });
  return {
    send(message) { socket.send(JSON.stringify(message)); },
    wait(predicate, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`응답 대기 실패: ${state?.phase}, ${state?.roundIndex}`)); }, timeoutMs);
        function check(message) {
          if (!predicate(message)) return;
          clearTimeout(timer); listeners.delete(check); resolve(message);
        }
        listeners.add(check);
      });
    },
    waitState(predicate) {
      if (state && predicate(state)) return Promise.resolve(state);
      return this.wait((message) => message.type === 'state' && predicate(message));
    },
    async update(message) {
      const result = this.wait((message) => message.type === 'questionsUpdateResult');
      this.send(message);
      return result;
    },
  };
}

test('CSV 업로드: 방장·대기실 권한, 방별 분리, 실제 출제·채점·결승·기본 복원', async (t) => {
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), ROUND_DURATION_MS: '1500', ROUND_INTRO_MS: '50', INTERMISSION_MS: '50', WHEEL_DURATION_MS: '50', TEAM_REVEAL_MS: '50', PLACEMENT_MS: '100' },
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
  const questions = parseQuestionCsv(await readFile(new URL('../public/templates/malmoe-quiz-example.csv', import.meta.url), 'utf8'));
  const host = await connect();
  host.send({ type: 'createRoom', name: '선생님', playMode: 'tablet' });
  const lobby = await host.waitState((state) => state.self);
  const guest = await connect();
  guest.send({ type: 'join', name: '학생', roomId: lobby.roomId });
  await guest.waitState((state) => state.self);
  const upload = { type: 'uploadQuestions', fileName: '수업 문제.csv', questions };
  assert.equal((await guest.update(upload)).ok, false);
  assert.equal((await guest.update({ type: 'clearQuestions' })).ok, false);
  assert.equal((await host.update({ ...upload, questions: [{ ...questions[0], answer: '없는 답' }] })).ok, false);
  assert.equal((await host.update(upload)).ok, true);
  const applied = await guest.waitState((state) => state.questionSet.count === 4);
  assert.equal(applied.questionSet.fileName, '수업 문제.csv');
  assert.equal('questions' in applied.questionSet, false);
  assert.equal('answer' in applied.questionSet, false);
  assert.ok(applied.roundModes.every((mode) => mode.name.startsWith('선생님 퀴즈')));

  const other = await connect();
  other.send({ type: 'createRoom', name: '다른 방', playMode: 'tablet' });
  const separate = await other.waitState((state) => state.self);
  assert.equal(separate.questionSet.count, 0, '다른 방에는 업로드한 문제가 섞이지 않아요');

  host.send({ type: 'start' });
  const first = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 0);
  const hostTeam = first.self.team;
  assert.equal(first.prompt.source, 'custom');
  assert.equal(first.prompt.choices.length, 4);
  assert.equal('answer' in first.prompt, false);
  assert.equal((await host.update(upload)).ok, false, '경기 중 업로드는 거절해요');
  assert.equal((await host.update({ type: 'clearQuestions' })).ok, false, '경기 중 기본 복원도 거절해요');

  async function answer(client, state) {
    const question = questions.find((entry) => entry.meaning === state.prompt.meaning);
    assert.ok(question, '모든 객관식 문제가 업로드한 문제 은행에서 나와야 해요');
    assert.equal(state.prompt.category, question.category);
    const result = client.wait((message) => message.type === 'choiceResult');
    client.send({ type: 'choice', promptId: state.prompt.id, choice: question.answer });
    const feedback = await result;
    assert.equal(feedback.correct, true);
    assert.equal(feedback.explanation, question.explanation);
    assert.ok(feedback.score >= 60 && feedback.score <= 100);
  }
  await answer(host, first);
  await host.waitState((state) => state.phase === 'intermission' && state.roundIndex === 0);
  for (let index = 1; index < 4; index += 1) {
    const winner = index % 2 ? guest : host;
    const round = await winner.waitState((state) => state.phase === 'round' && state.roundIndex === index);
    assert.equal(round.prompt.source, 'custom');
    await answer(winner, round);
    await host.waitState((state) => state.roundIndex === index && ['intermission', 'wheel'].includes(state.phase));
  }
  const final = await host.waitState((state) => state.phase === 'round' && state.roundIndex === 4);
  await answer(host, final);
  const result = await host.waitState((state) => state.phase === 'results');
  assert.equal(result.winner, hostTeam);
  host.send({ type: 'restart' });
  const restarted = await host.waitState((state) => state.phase === 'lobby');
  assert.equal(restarted.questionSet.count, 4, '새 게임 준비에도 업로드한 문제는 유지돼요');
  assert.equal((await host.update({ ...upload, questions: [] })).ok, false);
  const stillApplied = await guest.waitState((state) => state.phase === 'lobby');
  assert.equal(stillApplied.questionSet.count, 4, '잘못된 새 파일은 기존 문제를 덮어쓰지 않아요');
  assert.equal((await host.update({ ...upload, fileName: '새 문제.csv', questions: questions.slice(0, 2) })).ok, true);
  const replaced = await guest.waitState((state) => state.questionSet.count === 2);
  assert.ok(replaced.questionSet.revision > applied.questionSet.revision);
  assert.equal((await host.update({ type: 'clearQuestions' })).ok, true);
  const cleared = await guest.waitState((state) => state.questionSet.count === 0);
  assert.equal(cleared.roundModes[0].name, '순우리말 뜻풀이');

  // Typing mode uses the custom bank only in its quiz round.
  const typist = await connect();
  typist.send({ type: 'createRoom', name: '타자 선생님' });
  const typingLobby = await typist.waitState((state) => state.self);
  const typingGuest = await connect();
  typingGuest.send({ type: 'join', name: '타자 학생', roomId: typingLobby.roomId });
  await typingGuest.waitState((state) => state.self);
  assert.equal((await typist.update(upload)).ok, true);
  typist.send({ type: 'start' });
  const wordRound = await typist.waitState((state) => state.phase === 'round' && state.roundIndex === 0);
  assert.equal(wordRound.prompt.kind, 'word');
  typist.send({ type: 'answer', answer: wordRound.prompt.word });
  const quizRound = await typist.waitState((state) => state.phase === 'round' && state.roundIndex === 1);
  assert.equal(quizRound.prompt.source, 'custom');
  await answer(typist, quizRound);

  // Oversized input closes only that socket and leaves the game server running.
  const oversize = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  sockets.push(oversize);
  oversize.on('error', () => {});
  await new Promise((resolve) => oversize.once('open', resolve));
  const closed = new Promise((resolve) => oversize.once('close', resolve));
  oversize.send('x'.repeat(300 * 1024));
  await closed;
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/health`)).ok, true);
});
