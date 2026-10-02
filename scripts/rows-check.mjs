// 사용: node scripts/rows-check.mjs . tug 5201  (저장소 루트에서)
// 줄(pu) 또는 칸(pf) 변경 시험: ROWS=2이면 현재 화면과 같은 방식으로 합친 명단을 검증한다.
// 사용: node rows-check.mjs <repo> <tug|soccer|tball> <port>
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';
const [repoArg, game, port] = process.argv.slice(2);
const repo = resolve(repoArg);
const WebSocket = createRequire(pathToFileURL(resolve(repo, 'package.json')))('ws');
const tug = game === 'tug';
const learningAt = !tug ? (await import(pathToFileURL(resolve(repo, 'public/shared/learning.js')).href)).learningAt : null;
const srv = spawn(process.execPath, ['server/index.js'], { cwd: repo, env: { ...process.env, PORT: port, HOST: '127.0.0.1', ROUND_INTRO_MS: '200', PLACEMENT_MS: '100', TEAM_REVEAL_MS: '100' }, stdio: ['ignore', 'pipe', 'inherit'] });
await once(srv.stdout, 'data');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, pass, extra = '') => { if (!pass) failed += 1; console.log((pass ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
// 화면(net.js / main.js)의 mergeState 와 같은 합치기
function mergeState(base, msg) {
  if (msg.full !== false) return msg;
  const next = { ...base, ...msg };
  if ((Array.isArray(msg.pu) || Array.isArray(msg.po) || Array.isArray(msg.pf)) && Array.isArray(base?.players)) { next.players = Array.isArray(msg.po) ? msg.po.map((f) => base.players[f]) : base.players.slice(); for (const [i, p] of msg.pu || []) next.players[i] = p; for (const [i, fields] of msg.pf || []) if (next.players[i]) next.players[i] = { ...next.players[i], ...fields }; }
  delete next.pu; delete next.po; delete next.pf;
  return next;
}
async function connect(rows) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?delta=1${rows ? '&rows=' + (process.env.ROWS || '1') : ''}`, { perMessageDeflate: true });
  ws.m = []; ws.state = null; ws.pu = 0; ws.pf = 0; ws.full = 0; ws.playersMsgs = 0; ws.bytes = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw); ws.m.push(m);
    if (m.type === 'quiz') ws.quiz = m;
    if (m.type !== 'state') return;
    ws.bytes += raw.length;
    if (m.pu || m.po) ws.pu += 1;
    if (m.pf) ws.pf += 1;
    if (m.full === false && m.players) ws.playersMsgs += 1;
    ws.state = mergeState(ws.state, m);
  });
  await once(ws, 'open'); return ws;
}
async function wait(ws, pred) { for (let i = 0; i < 300; i++) { const x = ws.m.find(pred); if (x) return x; await pause(20); } throw new Error('timeout ' + JSON.stringify(ws.m.slice(-2)).slice(0, 200)); }
const all = [];
try {
  const host = await connect(true); all.push(host);
  host.send(JSON.stringify(tug ? { type: 'createRoom', name: 'T', playMode: 'tablet', hostParticipation: 'observe' } : { type: 'create', settings: { halfMinutes: 3 } }));
  const created = await wait(host, (m) => m.type === (tug ? 'roomCreated' : 'welcome'));
  const room = created.room || created.roomId;
  const join = async (name, rows) => { const s = await connect(rows); s.send(JSON.stringify({ type: 'join', roomId: room, name })); await wait(s, (m) => m.type === (tug ? 'joined' : 'welcome') || m.type === 'error'); all.push(s); return s; };
  const students = [];
  for (let i = 0; i < 10; i++) students.push(await join('S' + i, true));
  const reference = await join('REF', false);
  await pause(400);
  host.send(JSON.stringify(tug ? { type: 'start' } : { type: 'host', action: 'start' }));
  await pause(tug ? 800 : 7000);
  let k = 0;
  const answer = setInterval(() => { k++; for (const ws of students) { if (ws.readyState !== 1) continue; if (tug && k % 5 === 0) ws.send(JSON.stringify({ type: 'choice', promptId: ws.state?.prompt?.id, choice: ws.state?.prompt?.choices?.[k % 4] })); else if (!tug && k % 5 === 0 && ws.quiz) ws.send(JSON.stringify({ type: 'answer', idx: ws.quiz.idx, value: learningAt(ws.quiz.seed, ws.quiz.idx, ws.quiz.settings).answer })); } }, 100);
  await pause(1000);
  for (const w of [students[0], reference]) { w.pu = 0; w.pf = 0; w.playersMsgs = 0; w.bytes = 0; }
  await pause(3000);
  const steady = { s: { pu: students[0].pu, pf: students[0].pf, full: students[0].playersMsgs, bytes: students[0].bytes }, r: { bytes: reference.bytes } };
  const late = await join('LATE', true); // 경기 중 입장(명단 변경) — 앱이 막으면 error 를 받는다
  const lateOk = !late.m.some((m) => m.type === 'error');
  await pause(1500);
  students[9].close(); // 접속 끊김
  await pause(3000);
  clearInterval(answer);
  await pause(1500);
  const ref = JSON.stringify(reference.state?.players);
  check('기준 화면 명단 있음', Array.isArray(reference.state?.players), `${reference.state?.players?.length}명, 중간 입장 ${lateOk ? '허용' : '거부(앱 규칙)'}`);
  const viewers = [host, ...students.slice(0, 9), ...(lateOk ? [late] : [])];
  const same = viewers.filter((v) => JSON.stringify(v.state?.players) === ref).length;
  check('새 화면 명단이 기준과 같음', same === viewers.length, `${same}/${viewers.length}`);
  check('경기 중(인원 변화 없음)에는 players 전체를 보내지 않음', steady.s.full === 0, `바뀐 줄 ${steady.s.pu}회, 바뀐 칸 ${steady.s.pf}회, 전체 ${steady.s.full}회`);
  if (process.env.ROWS === '2') check('현재 화면은 바뀐 칸(pf)을 받음', steady.s.pf > 0);
  check('예전 화면은 pu·pf 를 받지 않음', reference.pu === 0 && reference.pf === 0);
  check('경기 중 받은 state 바이트가 예전 화면보다 작음', steady.s.bytes < steady.r.bytes, `${steady.s.bytes}B vs ${steady.r.bytes}B`);
} catch (e) { failed += 1; console.log('FAIL 실행 오류 — ' + e.message); }
finally { for (const ws of all) ws.terminate(); srv.kill(); }
console.log(failed ? `실패 ${failed}건` : '모두 통과');
process.exit(failed ? 1 : 0);
