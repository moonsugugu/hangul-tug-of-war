const key = (roomId) => `hangul-tug-session:${roomId}`;
export function loadSession(roomId, storage) {
  if (!roomId) return null;
  try {
    storage ??= globalThis.localStorage;
    const value = JSON.parse(storage.getItem(key(roomId)) || 'null');
    return typeof value?.token === 'string' && typeof value?.name === 'string' ? value : null;
  } catch { return null; }
}
export function saveSession(roomId, value, storage) {
  try { storage ??= globalThis.localStorage; storage.setItem(key(roomId), JSON.stringify(value)); } catch { /* 저장이 제한된 브라우저에서도 입장 가능 */ }
}
export function forgetSession(roomId, storage) {
  try { storage ??= globalThis.localStorage; storage.removeItem(key(roomId)); } catch { /* 저장이 제한된 브라우저 */ }
}
