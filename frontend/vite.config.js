import fs from "node:fs";
import path from "node:path";
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 프론트가 API 를 같은 출처로 호출하고(main.jsx 의 API_BASE 기본값이 빈 문자열),
// 여기서 /api 를 백엔드로 넘긴다. 덕분에 외부에는 프론트 포트 하나만 열면 된다.
// 파드 배포는 FRONTEND_PORT=1003, BACKEND_ORIGIN=http://127.0.0.1:1013 을 넣는다.
const port = Number(process.env.FRONTEND_PORT || 9602);
const target = process.env.BACKEND_ORIGIN || 'http://127.0.0.1:9601';

const allowedHosts = ['axforwork.wia.co.kr', 'dev-axforwork.wia.co.kr'];

const proxy = {
  '/api': {
    target,
    changeOrigin: true,
  },
};

function transportSecurity() {
  const keyFile = process.env.WIAREPORT_TLS_KEY_FILE || path.resolve(__dirname, 'certs/dev-key.pem');
  const certFile = process.env.WIAREPORT_TLS_CERT_FILE || path.resolve(__dirname, 'certs/dev-cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    throw new Error('WiaReport requires TLS certificate and key files. Configure WIAREPORT_TLS_CERT_FILE and WIAREPORT_TLS_KEY_FILE.');
  }
  return {
    key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile),
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3', honorCipherOrder: true,
    ciphers: [
      'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256',
      'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-RSA-CHACHA20-POLY1305', 'ECDHE-RSA-AES128-GCM-SHA256',
    ].join(':'),
  };
}

export default defineConfig(({ command }) => {
  // Missing TLS material must never silently enable plaintext HTTP.
  const https = command === 'serve' ? transportSecurity() : undefined;
  return {
  plugins: [react()],
  server: { host: '0.0.0.0', port, proxy, allowedHosts, https },
  preview: { host: '0.0.0.0', port, proxy, allowedHosts, https },
  };
});
