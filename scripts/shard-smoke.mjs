// 서버 나누기 시험: 서버 3개를 임시 포트로 띄우고 Cloudflare 처럼 경로로 나눠 주는 중계기(PROXY_PORT)를 함께 띄운다.
// 서버별 상태 주소·방 코드 첫 글자·같은 서버 입장·잘못된 경로 거부를 확인한다. 저장소 루트에서 `node scripts/shard-smoke.mjs`
// KEEP=1 이면 시험 뒤에도 서버와 중계기를 띄워 둔다(브라우저로 http://127.0.0.1:4600 확인용).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const ports = [4601, 4602, 4603];
const PROXY_PORT = 4600;
const servers = ports.map((port, i) => spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), SHARD_ID: String(i + 1), SHARD_COUNT: '3' }, stdio: ['ignore', 'pipe', 'inherit'] }));
await Promise.all(servers.map((s) => new Promise((r) => s.stdout.once('data', r))));
// Cloudflare 터널 규칙과 같게: /ws/s2 → 서버 2, /ws/s3 → 서버 3, 나머지 → 서버 1
const route = (url) => (/^\/ws\/s2(\/|$|\?)/.test(url) ? ports[1] : /^\/ws\/s3(\/|$|\?)/.test(url) ? ports[2] : ports[0]);
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: '127.0.0.1', port: route(req.url), path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
});
proxy.on('upgrade', (req, socket, head) => {
  const up = net.connect(route(req.url), '127.0.0.1', () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
let failed = 0;
const check = (name, pass, extra = '') => { if (!pass) failed += 1; console.log((pass ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const open = (path) => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${PROXY_PORT}${path}?delta=1&rows=1`); ws.m = []; ws.on('message', (d) => ws.m.push(JSON.parse(d))); ws.on('open', () => res(ws)); ws.on('error', rej); });
const wait = async (ws, type) => { for (let i = 0; i < 100; i++) { const m = ws.m.find((x) => x.type === type || x.type === 'error'); if (m) return m; await new Promise((r) => setTimeout(r, 30)); } return null; };
const sockets = [];
try {
  for (let n = 1; n <= 3; n++) {
    const h = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/ws/s${n}/health`)).json();
    check(`서버${n} 상태 주소(중계기 경유)`, h.shard === n && h.shards === 3, JSON.stringify(h));
    const host = await open(`/ws/s${n}`); sockets.push(host);
    host.send(JSON.stringify({ type: 'createRoom', name: '선생님', playMode: 'tablet', hostParticipation: 'observe' }));
    const created = await wait(host, 'roomCreated');
    const code = created?.roomId || '';
    check(`서버${n} 방 코드 첫 글자`, code[0] === '234'[n - 1] && code.length === 6, code);
    // 학생: 코드 첫 글자로 서버를 정해 접속한다(화면의 shardFromRoom 과 같은 규칙).
    const shard = '23456789'.indexOf(code[0]) + 1;
    const student = await open(`/ws/s${shard}`); sockets.push(student);
    student.send(JSON.stringify({ type: 'join', roomId: code, name: '학생' }));
    const joined = await wait(student, 'joined');
    check(`서버${n} 학생 입장`, joined?.type === 'joined', joined?.type === 'error' ? joined.message : '');
  }
  const bad = await new Promise((r) => { const ws = new WebSocket(`ws://127.0.0.1:${ports[0]}/wsx`); ws.on('open', () => r(false)); ws.on('error', () => r(true)); });
  check('잘못된 경로 거부', bad);
  const wrong = await open('/ws/s2'); sockets.push(wrong);
  wrong.send(JSON.stringify({ type: 'join', roomId: '2AAAAA', name: '학생' }));
  check('다른 서버의 코드로는 입장 안 됨(서버 2에 2AAAAA 없음)', (await wait(wrong, 'joined'))?.type !== 'joined');
} catch (e) { failed += 1; console.log('FAIL 실행 오류 — ' + e.message); }
console.log(failed ? `실패 ${failed}건` : '모두 통과');
if (process.env.KEEP !== '1') { sockets.forEach((s) => s.terminate()); servers.forEach((s) => s.kill()); proxy.close(); process.exit(failed ? 1 : 0); }
else console.log(`KEEP=1: http://127.0.0.1:${PROXY_PORT} 에서 화면 시험 가능 (Ctrl+C 로 종료)`);
