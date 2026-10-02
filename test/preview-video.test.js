import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

test('배포 버전과 첫 화면 영상·포스터·탐색용 바이트 요청을 확인해요', async (t) => {
  const video = await readFile(new URL('../public/videos/tug-preview.mp4', import.meta.url));
  const prefix = existsSync(new URL('../dist', import.meta.url)) ? '' : '/public';
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => server.kill());
  const [startup] = await once(server.stdout, 'data');
  const origin = String(startup).match(/http:\/\/localhost:(\d+)/)?.[0].replace('localhost', '127.0.0.1');
  assert.ok(origin, '서버가 실제로 할당된 포트를 알려 줘요');
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const path of ['/health', '/ws/s1/health', '/ws/s2/health', '/ws/s3/health']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.equal(health.version, version);
  }
  const url = `${origin}${prefix}/videos/tug-preview.mp4`;
  const whole = await fetch(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);
  for (const [range, start, end] of [['bytes=0-31', 0, 31], ['bytes=-16', video.length - 16, video.length - 1], [`bytes=${video.length - 8}-`, video.length - 8, video.length - 1]]) {
    const part = await fetch(url, { headers: { Range: range } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), video.subarray(start, end + 1));
  }
  for (const range of [`bytes=${video.length}-`, 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=-']) {
    assert.equal((await fetch(url, { headers: { Range: range } })).status, 416);
  }
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(Number(head.headers.get('content-length')), video.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const poster = await fetch(`${origin}${prefix}/videos/tug-preview-poster.jpg`);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');
});
