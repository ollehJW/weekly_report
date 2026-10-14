# PostgreSQL and AX login

WiaReport uses the shared `ax_platform_session` cookie and PostgreSQL `platform.users`, `platform.teams`, and `platform.sessions`. There are no WiaReport passwords or independent sessions. Old login/account/password mutation endpoints have been removed.

## Runtime configuration

Copy `config.example.yaml` to `config.yaml`, or set `WIAREPORT_DB_CONFIG` to a private configuration path. Keep `AX_DB_PASSWORD` in the environment or `database.env` beside the resolved configuration file. Neither file belongs in Git. On H200 they are under `/data/wiareport`; the source-root config is a symlink. `WIAREPORT_DATA_DIR=/data/wiareport` preserves existing attachment paths. Frontend HTTPS 1003 and backend HTTP 127.0.0.1:1013 are unchanged.

Frontend `/wiareport/agent` redirects to platform `/login?next=/wiareport/agent` without a session. Accounts missing a team go to the platform profile dialog. Admins do not need a team. Introduction, video and PDF remain public. Vite preserves Host for same-origin CSRF validation. Mutations require `X-Wia-Request: 1` and a matching Origin when present.

## Migration

Stop the SQLite backend before taking its final backup and migrating. The migration is transactional and refuses any nonempty destination schema:

```sh
.venv/bin/python ops/migrate_postgresql.py /data/wiareport/app.db --dry-run --manifest /data/wiareport/backups/preflight.json
.venv/bin/python ops/migrate_postgresql.py /data/wiareport/backups/final-app.db --manifest /data/wiareport/backups/postgresql-migration.json
```

It validates source foreign keys, all migrated row counts and SHA256 content digests before committing. Unique constraints, checks, foreign keys and indexes are recreated. `login_sessions` and credential columns are excluded. Legacy `users` become `members`: these are historical report participants and part assignments, never login accounts.

Team names and member names are matched only when unique within the exact platform team. Unmatched workspaces and members are preserved without granting anyone access by name. Private migration manifests list unresolved mappings for administrator review. Never map these automatically by name on later login. Team metadata and active membership refresh from platform on service access and scheduled report generation. Historical member IDs and all report/project references are retained; a member moving to another team receives a separate team membership, preserving old history.

On a new empty server with no SQLite data to import, install `platform` first and run `.venv/bin/python ops/init_postgresql.py`. For an existing deployment, transfer the PostgreSQL `wiareport` schema and `/data/wiareport/workspace` together and set the new DB connection.

## Permissions and behavior

- Team members come from current, active platform accounts. The member management and account management menus are removed; Part Management assigns current team members and projects to parts.
- All teammates can read team reports. Only the mapped owner can authorize, save, exclude projects, reorder a personal report, or set their absence. Admin role does not bypass authorship. Completed reports cannot be edited without reopening.
- Task Status defaults to participation; `all_projects=true` shows the current team/part's projects. This never expands access to other teams. Project management and the team dashboard keep team-wide lists.
- Old credential-bearing SQLite backup remains private for rollback; the running service never opens it.

## Validation

Use a separate `wiareport_test_*` schema in a private test config. Migrate into that empty schema, then run:

```sh
WIAREPORT_DB_CONFIG=/data/wiareport/test-config.yaml WIAREPORT_DATA_DIR=/tmp/wiareport-validation-data .venv/bin/python -m unittest discover -s tests -p test_platform_postgresql.py -v
```

The suite refuses the live schema. It verifies actual platform-cookie resolution, legacy-token rejection, team isolation, project filtering, CRUD, report ownership, report export, part moves and CSRF. Temporary platform session tokens are removed by teardown. Earlier SQLite/team-password fixtures describe the retired authentication model and are superseded by this PostgreSQL integration suite.

Rollback before accepting PostgreSQL writes: stop the new backend, restore the backed-up source/build and original runtime command using the preserved SQLite file. After new PostgreSQL writes, never switch back to the older SQLite snapshot without reconciling new data.

## Requested cleanup and platform layout (2026-10-14)

After migration, the 46 unmapped historical member records were removed at the user's request. Their 245 report-entry records, four project-entry records, one progress record and assignment links were archived first in `/data/wiareport/backups/unmapped-members-20261014.json` (private). Project records, event records, report periods and attachment files were retained. This is a post-migration cleanup; use the current PostgreSQL data when moving the service again.

The desktop shell now follows WiaMeet: a 224px sidebar, top breadcrumb, upper-right platform return link and consistent white page headings. The Task Status controls occupy a separate single-row toolbar, verified at 1100, 1280, 1440 and 1920px widths.


### 팀별 주간 보고 대상 설정
- 주간 보고 작성 → 멤버 관리에서 팀 전체의 작성 대상을 선택합니다. 파트 배정 및 통합 계정 자체는 변경하지 않습니다.
- `members.report_enabled`(기본 TRUE)에 저장합니다. 시작 시 기존 스키마에 열을 추가하며, 로그인 및 스케줄러의 멤버 동기화는 이 값을 유지합니다. 신규 팀원은 기본 포함됩니다.
- 진행 중인 보고의 대상과 완료 조건, 수동/자동 개설에 적용합니다. 제외된 멤버는 작성 API에서도 차단합니다. 기존 작성 데이터 및 완료된 보고 이력은 삭제하지 않습니다.
- 팀원 누구나 팀 설정을 관리할 수 있습니다. 다른 팀 접근은 차단하며 동시 편집 시 409로 재확인을 요청합니다.
- `python -m unittest tests.test_report_members -v`: 임시 격리 스키마에서 저장, 재동기화, 충돌, 권한, 완료 조건, 이력 보존, 수동/자동 개설을 검증하고 정리합니다. 플랫폼에 5분 만료의 검증용 세션을 만들고 종료 시 제거합니다.
- 네비게이션바의 사용 가이드 버튼은 제거했습니다.

- 팀원 부재 지정·해제는 같은 팀 사용자가 대신 처리할 수 있습니다. 완료된 보고, 비활성·작성 대상 제외 멤버, 다른 팀 보고는 변경할 수 없습니다. 보고 내용 작성 권한은 여전히 본인에게만 있습니다.
