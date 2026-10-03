// 남은 시간을 화면이 스스로 세는 방식(clock=1) 시험: 시간만 바뀐 메시지가 30초에 한 번(또는 시간이 튈 때)만 오고,
// 화면처럼 센 남은 시간이 서버 값(옛 화면 clock 없음)과 0.6초 안으로 맞는지. 저장소 폴더에서: node scripts/clock-check.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const WebSocket = createRequire(process.cwd() + '/package.json')('ws');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 19711;
const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ROUND_INTRO_MS: '200', PLACEMENT_MS: '100', TEAM_REVEAL_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => srv.stdout.once('data', r));
let failed = 0;
const ok = (name, pass, extra = '') => { console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!pass) failed++; };
const merge = (base, m) => (m.full !== false ? m : { ...base, ...m });
const open = (q) => new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?delta=1&rows=2${q}`); ws.raw = []; ws.state = null; ws.on('message', (d) => { const m = JSON.parse(d); ws.raw.push({ at: performance.now(), m }); if (m.type === 'state') { if (Object.keys(m).some((k) => k.endsWith('RemainingMs'))) ws.timerAt = performance.now(); ws.state = merge(ws.state, m); } else if (m.type === 'roomCreated') ws.room = m.roomId; }); ws.on('open', () => res(ws)); });
try {
  const host = await open('');
  host.send(JSON.stringify({ type: 'createRoom', name: 'T', playMode: 'tablet', hostParticipation: 'observe' }));
  await pause(400);
  const neu = await open('&clock=1'); neu.send(JSON.stringify({ type: 'join', roomId: host.room, name: 'NEW' }));
  const old = await open(''); old.send(JSON.stringify({ type: 'join', roomId: host.room, name: 'OLD' }));
  await pause(500);
  host.send(JSON.stringify({ type: 'start' }));
  await pause(2000);
  ok('라운드 진행 중', neu.state?.phase === 'round', neu.state?.phase);
  neu.raw = []; old.raw = [];
  const errs = [];
  for (let i = 0; i < 24; i++) {
    await pause(500);
    const live = Math.max(0, neu.state.timeRemainingMs - (performance.now() - neu.timerAt));
    const truth = Math.max(0, old.state.timeRemainingMs - (performance.now() - old.timerAt));
    errs.push(Math.abs(live - truth));
  }
  const timerOnly = (list) => list.filter(({ m }) => m.type === 'state' && Object.keys(m).every((k) => ['full', 'type', 'roomId'].includes(k) || k.endsWith('RemainingMs'))).length;
  ok('새 화면은 시간만 바뀐 메시지가 거의 없음(30초에 한 번)', timerOnly(neu.raw) <= 1, `12초 동안 ${timerOnly(neu.raw)}개`);
  ok('옛 화면은 그대로 자주(0.5초마다)', timerOnly(old.raw) >= 10, `12초 동안 ${timerOnly(old.raw)}개`);
  ok('화면이 센 남은 시간 = 서버 남은 시간(0.6초 안)', Math.max(...errs) <= 600, `최대 차이 ${Math.round(Math.max(...errs))}ms`);
  ok('받은 메시지 수가 줄어듦', neu.raw.length < old.raw.length / 2, `새 ${neu.raw.length}개 vs 옛 ${old.raw.length}개`);
} finally { srv.kill(); }
console.log(failed ? `실패 ${failed}건` : '모두 통과');
process.exit(failed ? 1 : 0);
