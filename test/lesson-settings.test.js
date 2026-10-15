import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { LOWER_WORD_PROMPTS, LOWER_QUIZ_POOLS, LOWER_SENTENCES, LOWER_REPAIR_PROMPTS } from '../server/lower-grade-prompts.js';
import { defaultRoundSettings, validateRoundSettings } from '../shared/round-settings.js';

test('저학년 문제와 시간 설정: 세 보기의 유일한 정답·짧은 문장·범위 검증', () => {
  for (const pool of Object.values(LOWER_QUIZ_POOLS)) for (const q of pool) {
    assert.equal(q.choices.length, 3); assert.equal(new Set(q.choices).size, 3);
    assert.equal(q.choices.filter(c => c === q.answer).length, 1); assert.ok(q.meaning && q.explanation);
  }
  assert.ok(LOWER_WORD_PROMPTS.every(q => [...q.word].length <= 3 && q.meaning && q.example));
  assert.ok(LOWER_SENTENCES.every(s => [...s].length <= 12));
  assert.ok(LOWER_REPAIR_PROMPTS.every(q => q.question === q.answer.replaceAll(' ', '')));
  const defaults = defaultRoundSettings('typing');
  assert.equal(defaults[3].answerSeconds, 12);
  assert.ok(defaultRoundSettings('tablet').every(r => r.answerSeconds === 0));
  for (const bad of [null, [], [...defaults, defaults[0]], defaults.map(r => ({ ...r, durationSeconds: 29 })), defaults.map(r => ({ ...r, answerSeconds: 121 })), defaults.map(r => ({ ...r, answerSeconds: '10' }))]) assert.throws(() => validateRoundSettings(bad, 30, 'typing'));
  assert.throws(() => validateRoundSettings(defaults, 9, 'typing'));
  assert.throws(() => validateRoundSettings(defaultRoundSettings('tablet'), 30, 'typing'));
  assert.deepEqual(validateRoundSettings(defaults, 30, 'typing'), defaults);
});

async function setup(t) {
  const server = spawn(process.execPath, ['server/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: '18981', ROUND_DURATION_MS: '10000', ROUND_INTRO_MS: '30', INTERMISSION_MS: '50', RELAY_DUEL_PAUSE_MS: '30', PLACEMENT_MS: '100', TEAM_REVEAL_MS: '50', WHEEL_DURATION_MS: '50' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => server.kill());
  await Promise.race([once(server.stdout, 'data'), delay(5000).then(() => { throw new Error('server startup timeout'); })]);
  return async (playMode = 'typing', roomId, token) => {
    const ws = new WebSocket('ws://127.0.0.1:18981/ws');
    t.after(() => ws.terminate());
    const messages = []; const listeners = new Set();
    const client = { state: null, messages, send: m => ws.send(JSON.stringify(m)), wait(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('message timeout: ' + client.state?.phase)); }, 6000);
        const check = m => { if (predicate(m)) { clearTimeout(timer); listeners.delete(check); resolve(m); } };
        listeners.add(check);
      });
    }, stateWhen(predicate) { return client.state && predicate(client.state) ? Promise.resolve(client.state) : client.wait(m => m.type === 'state' && predicate(m)); }, async command(message, predicate) { const done = client.wait(predicate); client.send(message); return done; } };
    ws.on('message', raw => { const m = JSON.parse(raw); messages.push(m); if (m.type === 'state') client.state = m; for (const listener of listeners) listener(m); });
    await once(ws, 'open');
    await client.command(token ? { type: 'resume', roomId, token } : roomId ? { type: 'join', name: '학생', roomId } : { type: 'createRoom', name: '교사', playMode, questionLevel: 'lower' }, m => m.type === 'state' && m.self);
    return client;
  };
}

test('실제 방: 저학년·라운드별 시간·개별 만료·부분 점수·권한·CSV·재시작', async t => {
  const connect = await setup(t);
  const host = await connect(); let guest = await connect('typing', host.state.roomId);
  const other = await connect('tablet');
  assert.equal(host.state.questionLevel, 'lower'); assert.ok(LOWER_WORD_PROMPTS.some(q => q.word === host.state.prompt.word));
  await guest.command({ type: 'setQuestionLevel', level: 'standard' }, m => m.type === 'error' && /방장/.test(m.message));
  await host.command({ type: 'setQuestionLevel', level: 'invalid' }, m => m.type === 'error');
  const rounds = [30, 31, 32, 33].map((durationSeconds, i) => ({ durationSeconds, answerSeconds: i === 3 ? 2 : 1 }));
  await guest.command({ type: 'setRoundSettings', roundSettings: rounds, placementSeconds: 20 }, m => m.type === 'error' && /방장/.test(m.message));
  await host.command({ type: 'setRoundSettings', roundSettings: rounds, placementSeconds: 20 }, m => m.type === 'state' && m.placementDurationMs === 20000);
  assert.deepEqual(host.state.roundSettings, rounds); assert.equal(other.state.roundSettings[0].answerSeconds, 0);
  const guestId = guest.state.self.id;
  guest = await connect('typing', host.state.roomId, guest.messages.find(m => m.type === 'joined').token);
  assert.equal(guest.state.self.id, guestId);
  assert.equal(guest.state.questionLevel, 'lower'); assert.deepEqual(guest.state.roundSettings, rounds);
  await host.command({ type: 'setRoundSettings', roundSettings: rounds.map(r => ({ ...r, durationSeconds: 999 })), placementSeconds: 20 }, m => m.type === 'error');
  assert.deepEqual(host.state.roundSettings, rounds);
  await host.command({ type: 'start' }, m => m.type === 'state' && m.phase === 'placement');
  assert.equal(host.state.placementDurationMs, 20000); assert.ok(host.state.placementRemainingMs > 19000);
  assert.ok(LOWER_SENTENCES.includes(host.state.prompt.sentence));
  await host.command({ type: 'restart' }, m => m.type === 'state' && m.phase === 'lobby');
  assert.equal(host.state.questionLevel, 'lower'); assert.deepEqual(host.state.roundSettings, rounds);
  await host.command({ type: 'startWaiting' }, m => m.type === 'state' && m.phase === 'round');
  assert.ok(host.state.timeRemainingMs > 29000 && host.state.timeRemainingMs <= 30000);
  await host.command({ type: 'setQuestionLevel', level: 'standard' }, m => m.type === 'error' && /대기실/.test(m.message));
  await host.command({ type: 'setRoundSettings', roundSettings: rounds, placementSeconds: 20 }, m => m.type === 'error');
  // A timed partial draft is paid once; an answer for its old ID cannot hit the next question.
  for (let i = 0; host.state.prompt.word.length < 2 && i < 20; i++) {
    const p = host.state.prompt;
    await host.command({ type: 'answer', answer: p.word, promptId: p.id }, m => m.type === 'answerResult');
    await host.stateWhen(s => s.prompt?.id !== p.id);
  }
  const old = host.state.prompt; assert.ok(old.word.length >= 2);
  const partial = host.wait(m => m.type === 'timeoutScore');
  const expired = host.wait(m => m.type === 'answerTimeout');
  host.send({ type: 'draft', promptId: old.id, text: old.word[0] });
  assert.ok((await partial).score > 0); await expired;
  await host.stateWhen(s => s.prompt?.id !== old.id);
  const score = host.state.self.score; const answers = host.messages.filter(m => m.type === 'answerResult').length;
  host.send({ type: 'answer', promptId: old.id, answer: old.word }); await delay(150);
  assert.equal(host.messages.filter(m => m.type === 'answerResult').length, answers); assert.equal(host.state.self.score, score);
  for (const index of [1, 2, 3]) {
    await host.command({ type: 'selectWaitingRound', roundIndex: index }, m => m.type === 'state' && m.phase === 'round' && m.roundIndex === index);
    assert.ok(host.state.timeRemainingMs > (rounds[index].durationSeconds - 1) * 1000);
    if (index === 1) {
      const p = host.state.prompt; assert.equal(p.choices.length, 3); assert.equal(p.answer, undefined);
      const before = { ...host.state.scores };
      await host.wait(m => m.type === 'answerTimeout'); await host.stateWhen(s => s.prompt?.id !== p.id);
      assert.deepEqual(host.state.scores, before, '미응답 객관식은 감점하지 않음');
    } else if (index === 2) {
      const p = host.state.prompt; const q = LOWER_REPAIR_PROMPTS.find(q => q.question === p.question); assert.ok(q);
      const result = await host.command({ type: 'answer', answer: q.answer, promptId: p.id }, m => m.type === 'answerResult'); assert.equal(result.correct, true);
    } else {
      assert.ok(LOWER_SENTENCES.includes(host.state.prompt.prompt));
      const deadline = host.state.prompt.relayDeadline; assert.ok(deadline - Date.now() <= 2000 && deadline > Date.now());
      await host.wait(m => m.type === 'state' && (m.relay?.lastResult || m.prompt?.relayDeadline !== deadline));
    }
  }
  await host.command({ type: 'restart' }, m => m.type === 'state' && m.phase === 'lobby');
  assert.deepEqual(host.state.roundSettings, rounds);
  await host.command({ type: 'setQuestionLevel', level: 'standard' }, m => m.type === 'state' && m.questionLevel === 'standard');
  const upload = await other.command({ type: 'uploadQuestions', fileName: 'test.csv', questions: [{ meaning: '업로드 문제', choices: ['하나', '둘', '셋', '넷'], answer: '하나', explanation: '교사 해설', category: '분류' }] }, m => m.type === 'questionsUpdateResult');
  assert.equal(upload.ok, true, upload.message);
  await other.stateWhen(s => s.questionSet.count === 1);
  await other.command({ type: 'startWaiting' }, m => m.type === 'state' && m.phase === 'round');
  assert.equal(other.state.prompt.source, 'custom'); assert.equal(other.state.prompt.choices.length, 4);
  await other.command({ type: 'restart' }, m => m.type === 'state' && m.phase === 'lobby');
  await other.command({ type: 'clearQuestions' }, m => m.type === 'questionsUpdateResult');
  await other.command({ type: 'startWaiting' }, m => m.type === 'state' && m.phase === 'round');
  for (let index = 0; index < 4; index++) {
    if (index) await other.command({ type: 'selectWaitingRound', roundIndex: index }, m => m.type === 'state' && m.roundIndex === index);
    assert.equal(other.state.prompt.choices.length, 3);
    const pool = index === 0 ? LOWER_QUIZ_POOLS.words : index === 1 ? LOWER_QUIZ_POOLS.principles : index === 2 ? LOWER_QUIZ_POOLS.sejong : LOWER_QUIZ_POOLS.mixed;
    const q = pool.find(q => q.meaning === other.state.prompt.meaning); assert.ok(q);
    const result = await other.command({ type: 'choice', choice: q.answer, promptId: other.state.prompt.id }, m => m.type === 'choiceResult'); assert.equal(result.correct, true);
  }
  // Force a 2:2 classroom match through scored answers, then verify the selected final timer.
  await other.command({ type: 'restart' }, m => m.type === 'state' && m.phase === 'lobby');
  const finalRounds = rounds.map(r => ({ ...r, answerSeconds: 5 }));
  await other.command({ type: 'setRoundSettings', roundSettings: finalRounds, placementSeconds: 30 }, m => m.type === 'state' && m.roundSettings[0].answerSeconds === 5);
  const opponent = await connect('tablet', other.state.roomId);
  await other.command({ type: 'start' }, m => m.type === 'state' && m.phase === 'round');
  await other.command({ type: 'setScoreMultiplier', multiplier: 7 }, m => m.type === 'state' && m.scoreMultiplier === 7);
  for (let index = 0; index < 4; index++) {
    await other.stateWhen(s => s.phase === 'round' && s.roundIndex === index);
    await opponent.stateWhen(s => s.phase === 'round' && s.roundIndex === index);
    const winner = [0, 3].includes(index) ? other : opponent;
    for (let attempt = 0; attempt < 6 && winner.state.phase === 'round' && winner.state.roundIndex === index; attempt++) {
      const p = winner.state.prompt; const q = LOWER_QUIZ_POOLS.mixed.find(q => q.meaning === p.meaning); assert.ok(q);
      await winner.command({ type: 'choice', promptId: p.id, choice: q.answer }, m => m.type === 'choiceResult');
      await winner.stateWhen(s => s.prompt?.id !== p.id || s.phase !== 'round');
    }
  }
  const final = await other.stateWhen(s => s.phase === 'round' && s.roundIndex === 4);
  assert.deepEqual(final.roundWins, { blue: 2, white: 2 });
  const selected = final.wheelSelectedIndex;
  assert.equal(final.mode.duration, finalRounds[selected].durationSeconds * 1000);
  assert.ok(final.timeRemainingMs > (finalRounds[selected].durationSeconds - 1) * 1000);
  assert.ok(final.answerRemainingMs > 4000 && final.answerRemainingMs <= 5000);
});
