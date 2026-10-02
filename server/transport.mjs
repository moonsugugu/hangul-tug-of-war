// 방별 상태 비교용 캐시는 한 번의 방송 동안만 공유합니다.
export const MAX_BUFFERED_BYTES = 256 * 1024;

export function canSend(socket) {
  if (!socket || socket.readyState !== 1) return false;
  // 오래된 상태를 계속 쌓지 않고 재접속으로 최신 전체 상태를 받게 합니다.
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) { socket.terminate(); return false; }
  return true;
}

export function takeMessageToken(socket, now = Date.now()) {
  const bucket = socket.inputBucket ??= { tokens: 40, at: now, drops: 0 };
  bucket.tokens = Math.min(40, bucket.tokens + Math.max(0, now - bucket.at) * 0.02);
  bucket.at = now;
  if (bucket.tokens >= 10) bucket.drops = 0;
  if (bucket.tokens < 1) {
    if (++bucket.drops > 300) socket.terminate();
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

const ALWAYS_SENT = new Set(['type', 'room', 'roomId', 'playerId', 'serverTime', 'now', 'v']);

// players 한 줄씩의 JSON과 id 목록·자리표. 한 번의 방송 동안 같은 배열이면 다시 만들지 않는다.
function playerRows(players, serialized) {
  const cached = serialized.get('\u0000rows');
  if (cached && cached.value === players) return cached.rows;
  const ids = players.map((player) => player?.id);
  const rows = { ids, index: new Map(ids.map((id, index) => [id, index])), json: players.map((player) => JSON.stringify(player ?? null)) };
  serialized.set('\u0000rows', { value: players, rows });
  return rows;
}

// 같은 학생들(인원·id 같음, id 중복 없음)인지. 순서는 달라도 된다.
function sameMembers(prev, rows) {
  return prev.ids.length === rows.ids.length && prev.index.size === prev.ids.length && rows.index.size === rows.ids.length
    && rows.ids.every((id) => id != null && prev.index.has(id));
}

export function stateDelta(socket, state, serialized = new Map()) {
  const sent = socket.sentState ??= new Map();
  const full = sent.size === 0;
  const delta = { full };
  let changed = full;
  for (const [key, value] of Object.entries(state)) {
    if (ALWAYS_SENT.has(key)) { delta[key] = value; continue; }
    // 바뀐 학생 줄만 보내기(rows=1 새 화면): 명단 인원·순서가 그대로면 바뀐 항목만 pu([번호, 항목])로 보낸다.
    // 점수 하나가 바뀔 때마다 players 전체(30명 약 3~6KB)를 다시 보내던 것이 메시지의 80~99%였다.
    if (key === 'players' && socket.supportsRowPatch && !full && Array.isArray(value)) {
      const rows = playerRows(value, serialized);
      const prev = socket.sentRows;
      socket.sentRows = rows;
      if (prev && sameMembers(prev, rows)) {
        // 점수 순 정렬처럼 순서만 바뀌면 po(새 자리마다 이전 번호)를 보내고, 내용이 바뀐 줄만 pu 로 보낸다.
        const order = rows.ids.map((id) => prev.index.get(id));
        const patch = [];
        for (let index = 0; index < rows.json.length; index += 1) if (rows.json[index] !== prev.json[order[index]]) patch.push([index, value[index]]);
        if (order.some((from, index) => from !== index)) { delta.po = order; changed = true; }
        if (patch.length) { delta.pu = patch; changed = true; }
        continue;
      }
      sent.delete('players'); // 인원이 바뀌면 아래에서 players 전체를 보낸다
    }
    const cached = serialized.get(key);
    const json = cached && Object.is(cached.value, value) ? cached.json : JSON.stringify(value ?? null);
    if (!cached || !Object.is(cached.value, value)) serialized.set(key, { value, json });
    if (sent.get(key) === json) continue;
    sent.set(key, json);
    delta[key] = value === undefined ? null : value;
    changed = true;
  }
  if (full && socket.supportsRowPatch && Array.isArray(state.players)) socket.sentRows = playerRows(state.players, serialized);
  return changed ? delta : null;
}

// 비교 때 만든 JSON을 실제 패킷에서도 재사용합니다. 큰 공통 배열을 다시 직렬화하지 않습니다.
export function encodeMessage(message, serialized) {
  return '{' + Object.entries(message).map(([key, value]) => {
    const cached = serialized.get(key);
    const json = cached && Object.is(cached.value, value) ? cached.json : JSON.stringify(value ?? null);
    return JSON.stringify(key) + ':' + json;
  }).join(',') + '}';
}
