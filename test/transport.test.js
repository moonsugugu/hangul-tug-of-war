import test from 'node:test';
import assert from 'node:assert/strict';
import { canSend, encodeMessage, MAX_BUFFERED_BYTES, stateDelta, takeMessageToken } from '../server/transport.mjs';

test('전체 상태·변경분·삭제·재접속을 보존하고 다른 학생 상태가 섞이지 않는다', () => {
  const a = {}, b = {}, cache = new Map();
  const common = { type: 'state', roomId: 'ROOM', now: 1, players: [{ id: 'a' }], event: { id: 1 } };
  const first = stateDelta(a, { ...common, self: { id: 'a' } }, cache);
  assert.equal(first.full, true);
  const other = stateDelta(b, { ...common, self: { id: 'b' } }, cache);
  assert.equal(other.self.id, 'b');
  assert.equal(stateDelta(a, { ...common, now: 2, self: { id: 'a' } }, cache), null);
  const next = stateDelta(a, { ...common, now: 3, event: undefined, self: { id: 'a' } });
  assert.equal(next.full, false);
  assert.equal(next.event, null);
  assert.equal(next.players, undefined);
  assert.deepEqual({ ...first, ...next }.players, common.players);
  assert.equal(stateDelta({}, common).full, true);
});

test('느린 연결은 종료하고 닫힌 연결에는 전송하지 않는다', () => {
  let terminated = 0;
  const socket = { readyState: 1, bufferedAmount: MAX_BUFFERED_BYTES + 1, terminate() { terminated++; } };
  assert.equal(canSend(socket), false);
  assert.equal(terminated, 1);
  socket.bufferedAmount = 0;
  assert.equal(canSend(socket), true);
  socket.readyState = 3;
  assert.equal(canSend(socket), false);
});

test('입력 한도는 연결별로 적용되고 시간을 두면 회복한다', () => {
  const socket = { terminate() {} }, other = { terminate() {} };
  for (let i = 0; i < 40; i++) assert.equal(takeMessageToken(socket, 1000), true);
  assert.equal(takeMessageToken(socket, 1000), false);
  assert.equal(takeMessageToken(other, 1000), true);
  assert.equal(takeMessageToken(socket, 1050), true);
});

test('공통 필드 JSON 직렬화는 방송당 한 번만 실행한다', () => {
  let calls = 0;
  const players = { toJSON() { calls++; return [{ id: 'one' }]; } };
  const cache = new Map();
  for (let i = 0; i < 30; i++) stateDelta({}, { type: 'state', players, self: { id: i } }, cache);
  assert.equal(calls, 1);
});

test('전송 패킷에서도 비교용 JSON을 재사용하고 null·개인 값을 보존한다', () => {
  let calls = 0;
  const players = { toJSON() { calls++; return [{ name: '학생 "가"' }]; } };
  const cache = new Map();
  const delta = stateDelta({}, { type: 'state', players, self: { id: 'a' }, removed: undefined }, cache);
  const wire = JSON.parse(encodeMessage(delta, cache));
  assert.equal(calls, 1);
  assert.deepEqual(wire.players, [{ name: '학생 "가"' }]);
  assert.equal(wire.self.id, 'a');
  assert.equal(wire.removed, null);
});
