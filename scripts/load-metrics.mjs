// measure-load.mjs 전용 계측기. 운영 서버에서는 불러오지 않습니다.
import { monitorEventLoopDelay } from 'node:perf_hooks';
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
let cpu, start;
process.on('message', (msg) => {
  if (msg === 'start') { cpu = process.cpuUsage(); start = performance.now(); lag.reset(); process.send('started'); }
  if (msg === 'stop') {
    const used = process.cpuUsage(cpu), elapsed = performance.now() - start;
    process.send({ cpuMs: Math.round((used.user + used.system) / 1000), cpuCorePercent: +((used.user + used.system) / elapsed / 10).toFixed(1), p99Ms: +(lag.percentile(99) / 1e6).toFixed(1), rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  }
});
