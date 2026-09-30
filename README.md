# LavaRapido — Infrastructure

Shared local infrastructure for the LavaRapido microservices: SQL Server today, and later RabbitMQ
and the API Gateway. Every microservice lives in **its own repository**; this repository only
holds what they share: the database container, the compose file and the secrets template.

| Service | Repository | Port | Schemas | Status |
|---|---|---|---|---|
| `security-service` | `security-service` | 3001 | `security`, `audit` | Implemented |
| `customer-service` | `customer-service` | 3002 | `customer` | Implemented |
| `booking-service` | — | — | `catalog`, `booking` | Planned |
| `operations-service` | — | — | `execution` | Planned |
| `payment-service` | — | — | `promotion`, `payment` | Planned |
| `notification-service` | — | — | `notification` | Planned |

The frontend lives in `Front-end-proyecto-web`.

## Folder layout

Clone every repository side by side in the same folder:

```
Backend/
├── lavarapido-infra/      ← this repository
├── security-service/
├── customer-service/
└── ...
```

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
cd ../security-service
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
