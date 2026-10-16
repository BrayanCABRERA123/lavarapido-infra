# LavaRapido — Infrastructure

Shared local infrastructure for the LavaRapido microservices: SQL Server, RabbitMQ (domain events,
ADR-004) and Mailpit, plus the compose profile that runs the API Gateway and every service in containers. Every
microservice lives in **its own repository**; this repository only holds what they share: the database container, the
compose file, the secrets template, the end-to-end tests (`e2e/`) and the production scripts (`deploy/`).

| Service | Repository | Port | Schemas | Status |
|---|---|---|---|---|
| `security-service` | `lavarapido-security-service` | 3001 | `security`, `audit` | Implemented |
| `customer-service` | `lavarapido-customer-service` | 3002 | `customer` | Implemented |
| `booking-service` | `lavarapido-booking-service` | 3003 | `catalog`, `booking` | Implemented |
| `operations-service` | `lavarapido-operation-service` | 3004 | `execution` | Implemented |
| `payment-service` | `lavarapido-payment-service` (.NET 8) | 3005 | `promotion`, `payment` | Implemented |
| `notification-service` | `lavarapido-notification-service` | 3006 | `notification` | Implemented |
| `api-gateway` | `lavarapido-api-gateway` | 8080 | — | Implemented |

The web app lives in `Front-end-proyecto-web` and the Android app in `LavadoVehicular-Movil`. The public
server is described in [`DEPLOY.md`](DEPLOY.md).

## Folder layout

Clone every repository side by side in the same folder:

```
Backend/
├── lavarapido-infra/      ← this repository
├── lavarapido-security-service/
├── lavarapido-customer-service/
└── ...
```

Team guide (Spanish): [`GUIA-EQUIPO.md`](GUIA-EQUIPO.md).

The services find the shared `.env` at `../lavarapido-infra/.env`, and `docker compose` builds
them from `../<service>`.

## Requirements

- Docker Desktop
- JDK 21+ to run a service outside Docker (each service ships the Maven Wrapper `mvnw`)

## Run locally

```bash
# 1. Secrets (once)
cp .env.example .env        # set DB_PASSWORD and JWT_SECRET (openssl rand -base64 48)

# 2. Database
docker compose up -d        # SQL Server 2022 + creates the LavaRapido database

# 3. A service, from its own repository
cd ../lavarapido-security-service
./mvnw spring-boot:run      # Windows: .\mvnw.cmd spring-boot:run
```

Or everything in containers: `docker compose --profile app up -d --build`.

## Why the database is shared

All services use one SQL Server instance with **one set of schemas per service** (ADR-003,
ADR-009): no service reads or writes another service's schemas, and each one migrates only its
own through Liquibase (its own `DATABASECHANGELOG_<SERVICE>` table). Services stay independent in
code, build, tests and deployment; only the database server process is shared, so running two
services never starts two SQL Servers fighting over port 1433.

## Shared contract between services

- **JWT:** the same `JWT_SECRET`, issuer and audience in every service (ADR-006).
- **Errors:** RFC 9457 `application/problem+json` with a stable `code`.
- **Conventions:** hexagonal architecture (ADR-007), identifiers in English, code comments in
  Spanish, secrets only through environment variables / `.env` — never committed.
