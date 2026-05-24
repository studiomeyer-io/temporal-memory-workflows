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
# 1) Create databases (one-time, idempotent)
docker exec dev2-postgres psql -U matthiasmeyer -d postgres -c "CREATE DATABASE temporal;"
docker exec dev2-postgres psql -U matthiasmeyer -d postgres -c "CREATE DATABASE temporal_visibility;"

# 2) Start cluster
cd /home/simple/temporal-memory-workflows/infrastructure/dev2
docker compose up -d

# 3) Wait for health (auto-setup runs schema migrations on first boot)
docker compose logs -f temporal | grep -i "started"

# 4) Verify
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

## Production Hardening (later)

- Pin `temporalio/auto-setup` to checksummed digest, not float tag
- Move from `auto-setup` to discrete `temporalio/server` + manual schema upgrades
- Add mTLS between Temporal services
- Cloudflare Tunnel + Access for Web UI (do NOT expose 8233 publicly without auth)
- Switch to dedicated Postgres role with `temporal_*` DB-scoped grants instead of superuser

See `docs/claude/temporal.md` in nex-hq for the canonical lifecycle doc.
