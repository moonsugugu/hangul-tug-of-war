// 실사용 계측 (문수네집 코드 규칙 7번, moonsugugu/coderule): 앱이 실제로 주고받는 양·CPU·메모리를 /health 에 붙인다.
// 보내는 내용은 바꾸지 않는다. 메시지 수·바이트를 세기만 한다(학생 개인정보 없음).
//   meter.attach(ws)   — WebSocket 연결마다 한 번(connection 이벤트에서)
//   meter.status()     — /health 에 traffic 으로 붙인다. 최근 1분 평균.
// 이 파일은 앱마다 그대로 복사해 쓴다(원본: coderule/tools/traffic-meter.mjs).

const TYPE_KEYS = [['"pq":', 'pq'], ['"pf":', 'pf'], ['"pu":', 'pu'], ['"pp":', 'pp'], ['"players":', 'players']];

function messageType(text) {
  // 앞부분에서 "type":"…" 만 읽는다(전체를 해석하지 않음)
  const head = text.length > 200 ? text.slice(0, 200) : text;
  const at = head.indexOf('"type":"');
  let type = at >= 0 ? head.slice(at + 8, head.indexOf('"', at + 8)) : (head.indexOf('"t":"') >= 0 ? head.slice(head.indexOf('"t":"') + 5, head.indexOf('"', head.indexOf('"t":"') + 5)) : '?');
  if (type.length > 24) type = type.slice(0, 24);
  if (type === 'state' || type === 'room') for (const [needle, name] of TYPE_KEYS) if (text.indexOf(needle) >= 0) { type += ':' + name; break; }
  return type || '?';
}

export function createTrafficMeter({ sampleMs = 10_000, windowSamples = 6 } = {}) {
  const totals = { msgsOut: 0, bytesOut: 0, msgsIn: 0, bytesIn: 0 };
  const byType = new Map(); // 보낸 메시지 종류 → [개수, 바이트]
  const sockets = new Set();
  let closedWire = 0;
  let peakSockets = 0;

  const wireOut = () => { let sum = closedWire; for (const ws of sockets) sum += ws._socket?.bytesWritten || 0; return sum; };
  const snapshot = () => ({ t: Date.now(), cpu: process.cpuUsage(), wire: wireOut(), ...totals, types: new Map([...byType].map(([k, v]) => [k, [...v]])) });
  const samples = [snapshot()];
  const timer = setInterval(() => { samples.push(snapshot()); while (samples.length > windowSamples + 1) samples.shift(); }, sampleMs);
  timer.unref?.();

  function attach(ws) {
    if (!ws || ws.__metered) return;
    ws.__metered = true;
    sockets.add(ws);
    peakSockets = Math.max(peakSockets, sockets.size);
    const send = ws.send.bind(ws);
    ws.send = (data, options, cb) => {
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data?.length || data?.byteLength || 0;
      totals.msgsOut += 1;
      totals.bytesOut += size;
      const type = typeof data === 'string' ? messageType(data) : 'binary';
      const row = byType.get(type) || [0, 0];
      row[0] += 1; row[1] += size;
      if (!byType.has(type) && byType.size >= 40) return send(data, options, cb); // 종류가 너무 많으면 더 늘리지 않음
      byType.set(type, row);
      return send(data, options, cb);
    };
    ws.on('message', (data) => { totals.msgsIn += 1; totals.bytesIn += data?.length || 0; });
    ws.on('close', () => { closedWire += ws._socket?.bytesWritten || 0; sockets.delete(ws); });
  }

  function status() {
    const now = snapshot();
    const old = samples[0];
    const sec = Math.max(1, (now.t - old.t) / 1000);
    const rate = (a, b) => Math.round(((a - b) / sec) * 10) / 10;
    const kbps = (a, b) => Math.round(((a - b) * 8) / sec / 100) / 10; // kbit/s, 소수 첫째
    const cpuMicros = (now.cpu.user - old.cpu.user) + (now.cpu.system - old.cpu.system);
    const types = [...now.types].map(([type, [n, b]]) => {
      const [n0, b0] = old.types.get(type) || [0, 0];
      return [type, rate(n, n0), kbps(b, b0)];
    }).filter(([, perSec]) => perSec > 0).sort((a, b) => b[2] - a[2]).slice(0, 6);
    return {
      windowSec: Math.round(sec),
      sockets: sockets.size,
      peakSockets,
      msgsOutPerSec: rate(now.msgsOut, old.msgsOut),
      kbpsOut: kbps(now.wire, old.wire), // 실제로 나간 양(압축 뒤)
      kbpsOutRaw: kbps(now.bytesOut, old.bytesOut), // 압축 전
      msgsInPerSec: rate(now.msgsIn, old.msgsIn),
      kbpsIn: kbps(now.bytesIn, old.bytesIn),
      cpuPct: Math.round((cpuMicros / 1000 / (sec * 1000)) * 1000) / 10,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      topTypes: types, // [종류, 초당 개수, kbps]
    };
  }

  return { attach, status, stop() { clearInterval(timer); } };
}
