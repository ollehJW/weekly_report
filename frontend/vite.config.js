import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 프론트가 API 를 같은 출처로 호출하고(main.jsx 의 API_BASE 기본값이 빈 문자열),
// 여기서 /api 를 백엔드로 넘긴다. 덕분에 외부에는 프론트 포트 하나만 열면 된다.
// 파드 배포는 FRONTEND_PORT=1003, BACKEND_ORIGIN=http://127.0.0.1:1013 을 넣는다.
const port = Number(process.env.FRONTEND_PORT || 9602);
const target = process.env.BACKEND_ORIGIN || 'http://127.0.0.1:9601';

const allowedHosts = ['axforwork.wia.co.kr'];

const proxy = {
  '/api': {
    target,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port, proxy, allowedHosts },
  preview: { host: '0.0.0.0', port, proxy, allowedHosts },
});
