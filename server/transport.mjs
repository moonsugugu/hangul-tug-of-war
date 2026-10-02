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

export function stateDelta(socket, state, serialized = new Map()) {
  const sent = socket.sentState ??= new Map();
  const full = sent.size === 0;
  const delta = { full };
  let changed = full;
  for (const [key, value] of Object.entries(state)) {
    if (ALWAYS_SENT.has(key)) { delta[key] = value; continue; }
    const cached = serialized.get(key);
    const json = cached && Object.is(cached.value, value) ? cached.json : JSON.stringify(value ?? null);
    if (!cached || !Object.is(cached.value, value)) serialized.set(key, { value, json });
    if (sent.get(key) === json) continue;
    sent.set(key, json);
    delta[key] = value === undefined ? null : value;
    changed = true;
  }
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
