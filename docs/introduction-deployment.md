# WiaReport introduction
- Introduction: https://axforwork.wia.co.kr/wiareport/
- Existing team-login app: https://axforwork.wia.co.kr/wiareport/agent
- Guide link: /wiareport/agent?guide=1 (opens after existing team login).
- Frontend HTTPS 1003, backend HTTP 127.0.0.1:1013 remain unchanged.
- Gateway strips /wiareport and forwards to https://axforwork.wia.co.kr:31003.
- Gateway require_login is false until platform SSO migration; backend team authentication remains enforced.
- Runtime video: /data/wiareport/media/WiaReport_intro.mp4. Symlink frontend/public/media to that directory before building. Media and credentials must not be committed.
- Favicon matches AX for Works. Relative Vite assets support both gateway and direct-port service URLs.
- Build: npm run build. Restart the existing Vite preview process only when its configuration changes.
