// 로컬 임시 서버에서 교사 1명과 학생들의 실제 압축 전송량을 측정합니다. node scripts/measure-load.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';
const label = 'load', only = null;
const configs = [['.','tug']];
const pause = ms => new Promise(r => setTimeout(r, ms));
for (const [folder, game] of configs) {
  if (only && only !== game) continue;
  const repo = resolve(folder), port = 19400 + ({ gojoseon: 0, hangul: 1, tug: 2, soccer: 3, tball: 4 })[game];
  const WebSocket = createRequire(pathToFileURL(resolve(repo, 'package.json')))('ws');
  const threeD = ['gojoseon','hangul'].includes(game), tug = game === 'tug';
  const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('scripts/load-metrics.mjs')).href, threeD ? 'server/index.mjs' : 'server/index.js'], { cwd: repo, env: { ...process.env, PORT: String(port), GAME_PORT: String(port), HOST: '127.0.0.1', ROUND_INTRO_MS: '200', PLACEMENT_MS:'100', TEAM_REVEAL_MS:'100' }, stdio: ['ignore','pipe','pipe','ipc'], windowsHide: true });
  let errors = ''; child.stderr.on('data', d => { errors += d; });
  const sockets = [];
  let mover;
  const learningAt = !threeD && !tug ? (await import(pathToFileURL(resolve(repo,'public/shared/learning.js')).href)).learningAt : null;
  try {
    await Promise.race([once(child.stdout, 'data'), pause(10000).then(() => { throw new Error('start timeout ' + errors); })]);
    const base = `ws://127.0.0.1:${port}${threeD ? '/v1/game?game=' + game + '&delta=1' : '/ws?delta=1'}`;
    async function connect(extra = '') {
      const ws = new WebSocket(base + extra, { perMessageDeflate: true }); ws.messages = []; ws.state = null;
      ws.on('message', raw => { const m = JSON.parse(raw); ws.messages.push(m); if (m.type === 'quiz') ws.quiz=m; if (m.type === 'state') ws.state = threeD ? (m.full ? m : { ...ws.state, ...m }) : m.full === false ? { ...ws.state, ...m } : m; });
      await once(ws,'open'); sockets.push(ws); return ws;
    }
    async function wait(ws, pred) { for (let i=0;i<150;i++) { const m=ws.messages.find(pred); if (m) return m; await pause(20); } throw new Error('message timeout '+game+' '+JSON.stringify(ws.messages.slice(-2))); }
    const host = await connect(threeD ? '&room=NEW&name=T' : '');
    host.send(JSON.stringify(threeD ? { type:'create_room',name:'T',teacherToken:'a'.repeat(48),settings:{maxPlayers:30} } : tug ? {type:'createRoom',name:'T',playMode:'tablet',hostParticipation:'observe'} : {type:'create',settings:{halfMinutes:3}}));
    const created = await wait(host,m=>m.type === (threeD ? 'room_created' : tug ? 'roomCreated' : 'welcome'));
    const room = created.room || created.roomId;
    const studentCount = game === 'soccer' ? 26 : 30;
    for(let i=0;i<studentCount;i++) {
      const student = await connect(threeD ? '&room='+room+'&name=S'+i : '');
      if(!threeD) student.send(JSON.stringify({type:'join',roomId:room,name:'S'+i}));
      await wait(student,m=>m.type === (threeD ? 'connected' : tug ? 'joined' : 'welcome') && (threeD ? !!m.playerId : true));
    }
    await pause(400);
    host.send(JSON.stringify(threeD ? {type:'start_game'} : tug ? {type:'start'} : {type:'host',action:'start'}));
    await pause(threeD || tug ? 800 : 7000);
    for(const ws of sockets.slice(1)) {
      const me = ws.state?.players?.find(p=>p.id === ws.state.playerId);
      if(me) { ws.x=me.x; ws.z=me.z; }
    }
    const initial = sockets.map(ws=>ws._socket.bytesRead);
    const started = performance.now();
    const metricsStart = once(child,'message'); child.send('start'); await metricsStart;
    let n=0;
    mover = setInterval(()=> { n++; for(const ws of sockets.slice(1)) {
      if(ws.readyState!==1) continue;
      if(threeD) ws.send(JSON.stringify({type:'move',x:ws.x+Math.sin(n/10)*0.8,z:ws.z+Math.cos(n/10)*0.8,facing:n/10+sockets.indexOf(ws)*0.17}));
      else if(tug && n%5===0) ws.send(JSON.stringify({type:'choice',promptId:ws.state?.prompt?.id,choice:ws.state?.prompt?.choices?.[n%4]}));
      else if(!tug && n%5===0 && ws.quiz) ws.send(JSON.stringify({type:'answer',idx:ws.quiz.idx,value:learningAt(ws.quiz.seed,ws.quiz.idx,ws.quiz.settings).answer}));
    } },100);
    await pause(6000); clearInterval(mover);
    const metricsStop=once(child,'message'); child.send('stop'); const [metrics]=await metricsStop;
    const elapsed=(performance.now()-started)/1000, bytes=sockets.reduce((sum,ws,i)=>sum+(ws._socket?.bytesRead||initial[i])-initial[i],0);
    if (bytes*8/elapsed/1e6 > 1) throw new Error('방 전송량이 1Mbps를 넘었습니다.');
    console.log(JSON.stringify({label,game,students:studentCount,clients:sockets.length,phase:host.state?.phase,seconds:+elapsed.toFixed(2),roomMbps:+(bytes*8/elapsed/1e6).toFixed(3),...metrics}));
  } finally { clearInterval(mover); for(const ws of sockets) ws.terminate(); child.kill(); }
}
