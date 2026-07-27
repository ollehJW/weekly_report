uvicorn backend.main:app --host 0.0.0.0 --port 9601 --reload
npm run dev -- --host 0.0.0.0 --port 9602

## systemd user services

The services in `ops/systemd/` keep the frontend and backend running after the
VS Code terminal is closed and restart them automatically if the process exits.

```bash
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
