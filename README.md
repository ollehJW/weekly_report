uvicorn backend.main:app --host 127.0.0.1 --port 9601 --reload
npm run dev -- --host 0.0.0.0 --port 9602

## systemd user services

The services in `ops/systemd/` keep the frontend and backend running after the
VS Code terminal is closed and restart them automatically if the process exits.

```bash
systemctl --user restart weekly-report-backend.service weekly-report-frontend.service
mkdir -p ~/.config/systemd/user
cp ops/systemd/weekly-report-*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now weekly-report-backend.service weekly-report-frontend.service
loginctl enable-linger "$USER"
```

Check status and logs:

```bash
systemctl --user status weekly-report-backend.service weekly-report-frontend.service
journalctl --user -u weekly-report-backend.service -u weekly-report-frontend.service -f
```


## HTTPS

개발서버 접속 주소: https://axforwork.wia.co.kr:31003

프론트엔드는 TLS 1.2/1.3만 제공하며 HTTP 서비스나 인증서 누락 시 HTTP 대체 실행은 하지 않습니다. 기존 HTTP 주소는 접속되지 않습니다. IP 주소는 도메인 인증서와 일치하지 않으므로 도메인으로 접속합니다. HTTP와 HTTPS는 저장소가 분리되어 있으므로 전환 후 다시 로그인합니다.

`WIAREPORT_TLS_CERT_FILE`(인증서 체인)과 `WIAREPORT_TLS_KEY_FILE`(개인키)을 설정하거나 `frontend/certs/dev-cert.pem`, `frontend/certs/dev-key.pem`에 인증서를 준비합니다. 인증서 파일은 Git에 포함하지 않습니다. 개발서버 파일은 `/data/wiareport/tls/`에 보관하고 해당 기본 경로에 심볼릭 링크를 둡니다. 키 권한은 600입니다.

백엔드는 `--host 127.0.0.1 --port 1013`, 프론트엔드는 `FRONTEND_PORT=1003 BACKEND_ORIGIN=http://127.0.0.1:1013`으로 실행합니다. 같은 서버의 루프백 프록시 구간만 HTTP이며 외부 백엔드 포트는 개방하지 않습니다. 인증서 갱신 후 프론트엔드를 재시작합니다.
