// 과부하 보호 (문수네집 코드 규칙 19, moonsugugu/coderule): 바쁠수록 느리게, 끊지는 않는다.
//
// 서버가 바쁜지는 이벤트 루프 지연(p99)으로 잰다. Node 는 일꾼이 하나라, 일이 밀리면 지연이 먼저 늘어난다.
//   0 평소       — 그대로
//   1 바쁨       — 방송 간격 2배. 하트비트로 연결을 끊지 않음(답이 늦은 건 서버가 바빠서일 수 있다)
//   2 매우 바쁨  — 방송 간격 3배. 새 방 만들기만 안내 문구로 막는다(이미 수업 중인 반을 지킨다)
// 올라갈 때는 바로, 내려갈 때는 5초 동안 조용해야 한 단계씩 내려간다(출렁임 방지).
// 켜진 뒤 20초는 재기만 하고 단계는 올리지 않는다(3D 서버는 시작할 때 지도 계산으로 몇 초 바쁘다).
// /health 의 peak 는 최근 10분 동안 가장 높았던 단계다.
// 기준은 환경변수 LOAD_BUSY_MS(기본 80) · LOAD_OVER_MS(기본 200) · LOAD_WARMUP_MS(기본 20000) 로 바꿀 수 있다. LOAD_GUARD=0 이면 끈다.
// 이 파일은 앱마다 그대로 복사해 쓴다(원본: coderule/tools/load-guard.mjs).
import { monitorEventLoopDelay } from 'node:perf_hooks';

export const BUSY_MESSAGE = '지금 사용자가 많아 순서대로 처리 중입니다. 잠시 후 다시 시도해 주세요.';
const LEVEL_NAMES = ['normal', 'busy', 'overloaded'];

export function createLoadGuard({
  busyMs = Number(process.env.LOAD_BUSY_MS) || 80,
  overMs = Number(process.env.LOAD_OVER_MS) || 200,
  sampleMs = 1000,
  calmMs = 5000,
  warmupMs = process.env.LOAD_WARMUP_MS !== undefined ? Number(process.env.LOAD_WARMUP_MS) : 20_000,
  peakWindowMs = 10 * 60_000,
  enabled = process.env.LOAD_GUARD !== '0',
  now = () => Date.now(),
} = {}) {
  let level = 0;
  let lagMs = 0;
  let calmSince = now();
  let busySince = null;
  let peakLevel = 0;
  let peakAt = now();
  const startedAt = now();
  let refusedRooms = 0;
  let sparedSockets = 0;

  function update(p99Ms) {
    lagMs = p99Ms;
    if (!enabled) { level = 0; return level; }
    if (now() - startedAt < warmupMs) return level; // 시작 직후는 단계에 넣지 않는다
    const target = p99Ms >= overMs ? 2 : p99Ms >= busyMs ? 1 : 0;
    const t = now();
    if (target >= level) {
      if (target > level && level === 0) busySince = t;
      level = target;
      calmSince = t;
    } else if (t - calmSince >= calmMs) {
      level -= 1;
      calmSince = t;
      if (level === 0) busySince = null;
    }
    if (level >= peakLevel) { peakLevel = level; peakAt = t; }
    else if (t - peakAt > peakWindowMs) { peakLevel = level; peakAt = t; }
    return level;
  }

  let timer = null;
  if (enabled && sampleMs > 0) {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    timer = setInterval(() => {
      update(histogram.percentile(99) / 1e6);
      histogram.reset();
    }, sampleMs);
    timer.unref?.();
  }

  return {
    get level() { return level; },
    get lagMs() { return lagMs; },
    /** 바쁠수록 방송 간격을 늘린다. */
    interval(baseMs) { return level >= 2 ? baseMs * 3 : level === 1 ? baseMs * 2 : baseMs; },
    /** 매우 바쁠 때는 새 방을 받지 않는다. false 면 BUSY_MESSAGE 로 안내한다. */
    canCreateRoom() {
      if (level < 2) return true;
      refusedRooms += 1;
      return false;
    },
    /**
     * 하트비트: 이 연결을 끊어도 되는지. 기존 `if (!isAlive) terminate` 자리에 쓴다.
     * 답 여부를 다른 이름에 두는 앱은 두 번째 값으로 넘긴다: shouldTerminate(ws, ws.ctx.alive)
     * 평소에는 두 번 연속 답이 없을 때만, 바쁜 동안에는 끊지 않는다(그래도 여섯 번 연속이면 끊는다).
     */
    shouldTerminate(socket, alive = socket.isAlive) {
      if (alive !== false) { socket.missedPings = 0; return false; }
      socket.missedPings = (socket.missedPings || 0) + 1;
      if (socket.missedPings >= 6) return true;
      if (level > 0) { sparedSockets += 1; return false; }
      return socket.missedPings >= 2;
    },
    /** /health 에 붙이는 값. */
    status() {
      return {
        level: LEVEL_NAMES[level],
        lagMs: Math.round(lagMs),
        busySec: busySince === null ? 0 : Math.round((now() - busySince) / 1000),
        peak: LEVEL_NAMES[peakLevel],
        refusedRooms,
        sparedSockets,
      };
    },
    update, // 시험용
    stop() { if (timer) clearInterval(timer); },
  };
}
