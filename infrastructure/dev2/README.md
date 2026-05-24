# Temporal Self-Hosted — Dev2 Setup

Minimal Postgres-only Temporal cluster sharing the existing `dev2-postgres` Docker container.

## Topology

| Service       | Image                          | Port (host)     | Notes                              |
|---------------|--------------------------------|-----------------|------------------------------------|
| temporal      | `temporalio/auto-setup:1.28.0` | `127.0.0.1:7233` | gRPC Frontend                      |
| temporal-ui   | `temporalio/ui:2.40.0`         | `127.0.0.1:8233` | Web UI (8080 reserved for n8n)     |
| persistence   | reuses `dev2-postgres:5432`    | —               | DBs: `temporal`, `temporal_visibility` |

No Elasticsearch — saves ~1-2 GB RAM. Visibility queries use Postgres standard visibility.

## Setup

```bash
# 1) Copy .env.example and fill in real Postgres credentials.
#    .env is gitignored — never commit real secrets.
cp .env.example .env
$EDITOR .env

# 2) Create databases (one-time, idempotent). Adjust user if your Postgres
#    instance uses a different superuser; the example assumes `dev2-postgres`
#    with a `matthiasmeyer` superuser.
docker exec dev2-postgres psql -U matthiasmeyer -d postgres -c "CREATE DATABASE temporal;"
docker exec dev2-postgres psql -U matthiasmeyer -d postgres -c "CREATE DATABASE temporal_visibility;"

# 3) Start cluster
cd infrastructure/dev2
docker compose up -d

# 4) Wait for health (auto-setup runs schema migrations on first boot)
docker compose logs -f temporal | grep -i "started"

# 5) Verify
curl -s http://localhost:8233/api/v1/namespaces | head
docker exec temporal tctl --address temporal:7233 cluster health
```

## Smoke Test

```bash
# Create dev namespace (auto-setup creates `default`, but explicit is good)
docker exec temporal tctl --address temporal:7233 --namespace memory-workflows namespace register --retention 72h

# List namespaces
docker exec temporal tctl --address temporal:7233 namespace list
```

## Tear Down

```bash
docker compose down                        # keeps DBs intact
docker compose down -v                     # also wipes named volumes (none here)
docker exec dev2-postgres psql -U matthiasmeyer -d postgres -c "DROP DATABASE temporal; DROP DATABASE temporal_visibility;"
```

## Resource Budget

| Resource | Reserved | Notes                       |
|----------|----------|-----------------------------|
| RAM      | ~700 MB  | auto-setup + ui combined    |
| CPU      | ~0.5 core | idle baseline              |
| Disk     | grows with workflow history; pruned per `NAMESPACE_RETENTION=72h` |

## Security Notes

- **Web UI has no authentication.** The compose binds `temporal-ui` to `127.0.0.1:8233`, so it is only reachable from the host. On a multi-user server, any user with SSH access can still port-forward and view/terminate workflows. For shared environments add Cloudflare Tunnel + Access (or equivalent) before exposing the UI.
- **No container resource limits** are set. `temporalio/auto-setup` can peak at 2-4 GB RAM during schema initialization. On laptops with <8 GB total, consider adding `deploy.resources.limits.memory: 2g` under each service.

## Production Hardening

- Pin `temporalio/auto-setup` to a checksummed digest, not the float tag
- Move from `auto-setup` to discrete `temporalio/server` + manual schema upgrades
- Add mTLS between Temporal services
- Put the Web UI behind authentication (Cloudflare Tunnel + Access, OIDC via `TEMPORAL_AUTH_ENABLED=true`, etc.)
- Switch to a dedicated Postgres role with `temporal_*` DB-scoped grants instead of a superuser
- Provision the `memory-workflows` namespace explicitly (`tctl namespace register --retention 72h memory-workflows`) — `NAMESPACE_RETENTION` only applies to the auto-created `default` namespace
- Add resource limits (`mem_limit`, `cpus`) to each service for capacity planning

See the [Temporal self-hosted deployment guide](https://docs.temporal.io/production-deployment/self-hosted-guide) for the upstream reference.
