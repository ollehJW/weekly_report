# WiaReport

WiaReport now uses PostgreSQL (`wiareport` schema) and AX for Works shared login.
Account/team identity is provided by the `platform` schema; there are no separate service passwords.

- Introduction: https://axforwork.wia.co.kr/wiareport/
- Application: https://axforwork.wia.co.kr/wiareport/agent
- [Database, migration, authentication and validation](docs/postgresql-platform-auth.md)
- [Introduction deployment](docs/introduction-deployment.md)

Configure `config.yaml` from `config.example.yaml` and provide `AX_DB_PASSWORD` privately.
Install `requirements.txt`, initialize or migrate the database, build the React frontend, and start the Python API.
H200 persistent assets/config/backups live under `/data/wiareport`; source is under `/home/jongwook/wiareport`.
