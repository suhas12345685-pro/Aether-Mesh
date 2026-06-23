# Aether Mesh — Cloud Deployment Guide

> End-to-end instructions for deploying Aether Mesh to a production cloud environment
> using the all-in-one Docker stack image, Nginx TLS termination, and the automated
> tenant provisioner.

---

## 1. Prerequisites

| Requirement | Minimum version | Notes |
|---|---|---|
| Docker Engine | 27+ | With BuildKit enabled |
| Docker Compose Plugin | 2.24+ | `docker compose` (not `docker-compose`) |
| A Linux VPS or Fly.io VM | 1 vCPU / 1 GB RAM | 2 GB RAM recommended for multi-tenant |
| A registered domain | — | You control DNS; e.g. `aethermesh.app` |
| Open inbound ports | 80, 443 | 80 for ACME challenge, 443 for HTTPS |

### Optional (for live integrations)
- **Twilio** account (phone identity)
- **Stripe** account (billing)
- **Mailgun** or **SendGrid** (inbound email)
- **Fly.io CLI** (`flyctl`) — only if deploying to Fly.io instead of a bare VPS

---

## 2. Clone the Repository

```bash
git clone https://github.com/aethermesh/aether-mesh.git
cd aether-mesh/aether
```

---

## 3. Configure `.env.cloud`

```bash
cp cloud/.env.cloud.example cloud/.env.cloud
$EDITOR cloud/.env.cloud
```

**Critical variables to fill in before first boot:**

```bash
# Your primary domain
DOMAIN=aethermesh.app

# 64-char hex master encryption key (NEVER commit this)
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
AETHER_SECRET_KEY=<64-hex-chars>

# Session cookie signing secret (any strong random string)
PLATFORM_SESSION_SECRET=<strong-random>

# Service-to-service admin tokens
INFRA_ADMIN_TOKEN=<random>
PLATFORM_ADMIN_TOKEN=<random>
```

---

## 4. Pull / Build the Stack Image

### Option A — Pull from GHCR (recommended for production)
```bash
docker pull ghcr.io/aethermesh/aether-stack:latest
```

### Option B — Build locally
```bash
# From the aether/ directory:
docker build -f Dockerfile.stack -t ghcr.io/aethermesh/aether-stack:latest .
```

---

## 5. Start the Stack

```bash
docker compose \
  -f cloud/docker-compose.cloud.yml \
  --env-file cloud/.env.cloud \
  up -d
```

This brings up:
- **`aether`** — all five services in one container (internal only, no published ports)
- **`nginx`** — TLS terminator, exposed on 443/80

Verify services are running:
```bash
docker compose -f cloud/docker-compose.cloud.yml ps
docker compose -f cloud/docker-compose.cloud.yml logs -f aether
```

---

## 6. SSL Certificate Setup (Let's Encrypt)

### 6a. Point DNS to your server

Create an **A record** (and AAAA for IPv6) for your domain and wildcard subdomain:

```
aethermesh.app         A   <your-server-ip>
*.aethermesh.app       A   <your-server-ip>
```

Wait for DNS propagation (~1-5 minutes for most registrars).

### 6b. Obtain the initial certificate

The nginx container includes certbot. Run the one-time certificate request:

```bash
docker compose -f cloud/docker-compose.cloud.yml \
  exec nginx certbot certonly \
  --webroot -w /var/www/certbot \
  --email admin@aethermesh.app \
  --agree-tos \
  --no-eff-email \
  -d aethermesh.app \
  -d '*.aethermesh.app'
```

> **Note:** Wildcard certificates require DNS-01 challenge (not webroot). For
> wildcard support use:
> ```bash
> certbot certonly --dns-cloudflare ...   # or your DNS provider's plugin
> ```

### 6c. Enable automatic renewal

```bash
# Enable the certbot-renew profile for background renewal:
docker compose -f cloud/docker-compose.cloud.yml \
  --env-file cloud/.env.cloud \
  --profile certbot-renew \
  up -d certbot
```

Or add a host-level cron to run the in-container renewal script:
```bash
# /etc/cron.d/aether-certbot
0 3 * * * root docker exec aether-cloud-nginx-1 /usr/local/bin/renew-certs.sh
```

### 6d. Reload nginx with the new cert

```bash
docker exec aether-cloud-nginx-1 nginx -s reload
```

---

## 7. First Admin Creation

After the stack is healthy, create the initial admin account via the platform API:

```bash
curl -X POST https://aethermesh.app/api/admin/bootstrap \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  -d '{
    "name": "Admin",
    "email": "admin@yourdomain.com",
    "password": "<strong-password>"
  }'
```

> The bootstrap endpoint is only available once (first admin) and is disabled
> afterward. Set `PLATFORM_ADMIN_TOKEN` in `.env.cloud` first.

---

## 8. Verify Health Checks

```bash
# Platform health (through nginx)
curl -I https://aethermesh.app/health

# Direct container health (bypasses nginx)
docker exec aether-cloud-aether-1 wget -qO- http://localhost:8080/health

# Infra service
docker exec aether-cloud-aether-1 wget -qO- http://localhost:8090/ready

# Supervisor
docker exec aether-cloud-aether-1 wget -qO- http://localhost:8091/health

# Check all container statuses
docker compose -f cloud/docker-compose.cloud.yml ps
```

Expected output from `/health`:
```json
{"status":"ok","service":"platform","uptime":...}
```

---

## 9. Tenant Provisioning (Cloud Multi-Tenant)

To spin up a new isolated tenant container:

```bash
# Make the provisioner script executable
chmod +x cloud/provisioner/provision-tenant.sh cloud/provisioner/deprovision.sh

# Provision a new tenant
DOMAIN=aethermesh.app \
AETHER_SECRET_KEY=<key> \
NGINX_UPSTREAM_MAP=./cloud/nginx/upstream.map \
NGINX_CONTAINER=aether-cloud-nginx-1 \
./cloud/provisioner/provision-tenant.sh acme-corp power acme
```

Output:
```json
{"url":"https://acme.aethermesh.app","container":"aether-acme-corp","tenant_id":"acme-corp","tier":"power"}
```

To deprovision:
```bash
./cloud/provisioner/deprovision.sh acme-corp
# or with data wipe:
./cloud/provisioner/deprovision.sh acme-corp --purge-data
```

---

## 10. Updating the Stack

```bash
# Pull latest image
docker pull ghcr.io/aethermesh/aether-stack:latest

# Rolling restart (zero-downtime with nginx keepalive)
docker compose -f cloud/docker-compose.cloud.yml \
  --env-file cloud/.env.cloud \
  up -d --no-deps aether
```

---

## 11. Logs and Monitoring

```bash
# Tail all logs
docker compose -f cloud/docker-compose.cloud.yml logs -f

# Service-specific logs (within the aether container)
docker exec aether-cloud-aether-1 tail -f /app/logs/platform.log
docker exec aether-cloud-aether-1 tail -f /app/logs/infra.log
docker exec aether-cloud-aether-1 tail -f /app/logs/supervisor.log

# Nginx access log
docker logs aether-cloud-nginx-1 -f
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| nginx 502 Bad Gateway | Aether container not healthy yet | `docker compose ps` — check health, wait for start_period |
| SSL cert not found | Certbot hasn't run | Follow step 6b above |
| `AETHER_SECRET_KEY` error | Missing in `.env.cloud` | Generate and set the 64-char hex key |
| Tenant subdomain not routing | nginx map not reloaded | Run `docker exec nginx-ctr nginx -s reload` |
| Container OOM killed | Tier memory limit too low | Increase `VM_MEMORY_MB` or use higher tier |
