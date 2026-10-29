// Shared, aggregate-only telemetry. No student names, room codes or answer data leave the game.
// 원본: moonsunezip-server-monitor/integrations/telemetry.mjs — 게임마다 server/ 에 그대로 복사해 쓴다.
//   const rooms = createRoomRegistry();                       // 기존 new Map() 대신
//   rooms.noteStudent(roomCode, seatId);                       // 학생이 자리에 들어올 때(재접속 포함, 같은 자리는 한 번만 셈)
//   const monitorSnapshot = createTelemetry(rooms, describeRoom, '학생 기준 설명', { game: 'hangul-tug', label: '말모이 줄다리기' });
//   /health 응답에 monitor: monitorSnapshot()
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// 한국 시간 날짜(YYYY-MM-DD). 한국은 서머타임이 없어 UTC+9 로 계산한다.
// Intl.DateTimeFormat 을 부를 때마다 새로 만들면 1번에 수십 µs 가 들어, 입장·health 마다 부르는 곳에서 피한다.
const KST_OFFSET_MS = 9 * 3600000;
export const dayKey = (at = Date.now()) => new Date(at + KST_OFFSET_MS).toISOString().slice(0, 10);

const MAX_SEATS_PER_ROOM = 2000;

export function createRoomRegistry() {
  return new class extends Map {
    roomsCreated = 0;
    createdToday = 0;
    studentsJoined = 0;
    joinedToday = 0;
    day = dayKey();
    bootId = randomUUID();
    // 방별로 이미 센 자리. 프로세스 메모리에만 있고 밖으로 내보내지 않는다. 방이 지워지면 같이 지운다.
    seats = new Map();
    updateDay() { const today = dayKey(); if (today !== this.day) { this.day = today; this.createdToday = 0; this.joinedToday = 0; } }
    set(key, value) {
      this.updateDay();
      if (!this.has(key)) { this.roomsCreated++; this.createdToday++; this.seats.delete(key); }
      return super.set(key, value);
    }
    delete(key) { this.seats.delete(key); return super.delete(key); }
    clear() { this.seats.clear(); return super.clear(); }
    // 학생 한 명이 방에 들어왔을 때 부른다. 같은 방의 같은 자리(재접속)는 다시 세지 않는다.
    noteStudent(roomKey, seatKey) {
      if (roomKey === undefined || roomKey === null || seatKey === undefined || seatKey === null) return false;
      this.updateDay();
      let seen = this.seats.get(roomKey);
      if (!seen) { seen = new Set(); this.seats.set(roomKey, seen); }
      const seat = String(seatKey);
      if (seen.has(seat)) return false;
      if (seen.size < MAX_SEATS_PER_ROOM) seen.add(seat);
      this.studentsJoined++; this.joinedToday++;
      return true;
    }
  }();
}

export function createTelemetry(rooms, describeRoom, studentDefinition, { game, label } = {}) {
  // No background timer. CPU measurements are calculated only when health is requested.
  let cpu = process.cpuUsage(), at = process.hrtime.bigint(), loop = performance.eventLoopUtilization(), measured = false;
  return () => {
    const now = process.hrtime.bigint(), usage = process.cpuUsage();
    const elapsed = Number(now - at) / 1000;
    const cpuOneCorePercent = measured && elapsed > 0 ? ((usage.user - cpu.user) + (usage.system - cpu.system)) / elapsed * 100 : null;
    const loopNow = performance.eventLoopUtilization();
    const eventLoopUtilizationPercent = measured ? performance.eventLoopUtilization(loopNow, loop).utilization * 100 : null;
    cpu = usage; at = now; loop = loopNow; measured = true;
    rooms.updateDay();
    let students = 0, activeRooms = 0;
    for (const room of rooms.values()) { const item = describeRoom(room); students += item.students; if (item.active) activeRooms++; }
    return {
      game, label,
      rooms: rooms.size, students, activeRooms, roomsCreated: rooms.roomsCreated,
      createdToday: rooms.createdToday, studentsJoined: rooms.studentsJoined, joinedToday: rooms.joinedToday,
      day: rooms.day, bootId: rooms.bootId, studentDefinition,
      process: { cpuOneCorePercent, memoryMB: process.memoryUsage().rss / 1024 ** 2, eventLoopUtilizationPercent, uptimeSeconds: Math.floor(process.uptime()) }
    };
  };
}
