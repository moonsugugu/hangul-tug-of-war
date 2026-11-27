import { defineConfig } from 'vite';

export default defineConfig({
  // 학교 태블릿은 브라우저가 오래된 경우가 많다. 새 문법(?. ?? ??= 등)을 옛 문법으로 바꿔 내보낸다.
  // 옛 브라우저에 없는 함수(.at, replaceAll)는 index.html 에서 채운다.
  build: { target: 'es2019' },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
