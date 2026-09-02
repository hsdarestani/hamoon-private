# HamoonCloud Reseller API v1

Production Base URL:

```text
https://pay.hamooncloud.ir/api/v1
```

All requests and responses use JSON. API keys must only be stored on the reseller backend/server and must never be exposed in browser/mobile frontend code.

## Authentication

```http
Authorization: Bearer hm_live_xxxxxxxxxxxxxxxxx
```

Example:

```bash
curl https://pay.hamooncloud.ir/api/v1/me \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

A missing/invalid key returns HTTP `401`.

## Account endpoints

### `GET /me`
Returns the authenticated reseller API client and configured limits.

### `GET /wallet`
Returns current reseller wallet balance.

### `GET /usage`
Returns API-client usage summary. This is API/account usage, not per-server network traffic.

### `GET /prices`
Returns currently sellable Hetzner plans and reseller prices. Always use this endpoint instead of hard-coding plan prices.

## Server endpoints

### `GET /servers`
Returns servers owned by this reseller account.

### `GET /servers/{id}`
Returns the reseller purchase record and current provider information when available, including status, public IPv4, server type and location.

### `POST /servers`
Creates a new server.

Example:

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers \
  -H "Authorization: Bearer $HAMOON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "customer-001",
    "server_type": "cpx22",
    "image": "ubuntu-24.04",
    "location": "nbg1",
    "duration": "monthly"
  }'
```

Supported creation fields: `server_type` (required), `name`, `image`, `location`, `duration`, `datacenter`, and `ssh_key`.

### `PATCH /servers/{id}/name`
Changes the HamoonCloud display name for the server. The name may contain normal Unicode text and is limited to 64 characters. Send an empty name to clear the custom display name and return to the technical server name.

```bash
curl -X PATCH https://pay.hamooncloud.ir/api/v1/servers/123456/name \
  -H "Authorization: Bearer $HAMOON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Customer Production"}'
```

Success:

```json
{ "ok": true, "status": "renamed", "name": "Customer Production" }
```

### `POST /servers/{id}/reset-password`
Requests a new root password from Hetzner and returns it once in the response. Store/transmit this value securely and do not log it.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/reset-password \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

Success:

```json
{
  "ok": true,
  "status": "password_reset",
  "root_password": "NEW_ROOT_PASSWORD"
}
```

### `POST /servers/{id}/snapshots`
Creates a Hetzner snapshot for the server. Snapshot creation is asynchronous.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/snapshots \
  -H "Authorization: Bearer $HAMOON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"description":"Before application upgrade"}'
```

Success returns HTTP `202` with the snapshot/image and provider action IDs when available.

### `GET /servers/{id}/snapshots`
Lists snapshots created from that server.

```bash
curl https://pay.hamooncloud.ir/api/v1/servers/123456/snapshots \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

### `POST /servers/{id}/rebuild`
Rebuilds the server using an allowed image. This operation replaces the server operating system/data on the server disk, so it must be treated as destructive.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/rebuild \
  -H "Authorization: Bearer $HAMOON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"image":"ubuntu-24.04"}'
```

Success returns HTTP `202`. If Hetzner generates a new root password during rebuild, it is returned as `root_password`; otherwise the field is `null`.

### `POST /servers/{id}/upgrade`
Changes the Hetzner server type to another allowed plan.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/upgrade \
  -H "Authorization: Bearer $HAMOON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"target_server_type":"cpx32","upgrade_disk":false}'
```

Use `GET /prices` to obtain valid target plan IDs. `upgrade_disk=true` permanently enlarges the disk where supported and normally prevents later downsizing to a smaller disk.

### `GET /servers/{id}/traffic`
Returns current Hetzner traffic counters in bytes.

```bash
curl https://pay.hamooncloud.ir/api/v1/servers/123456/traffic \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

Response shape:

```json
{
  "ok": true,
  "traffic": {
    "ingoing_bytes": 1200000000,
    "outgoing_bytes": 3400000000,
    "used_bytes": 4600000000,
    "included_bytes": 21990232555520,
    "remaining_bytes": 21985632555520,
    "overage_bytes": 0
  }
}
```

### `POST /servers/{id}/poweroff`
Powers off the server.

### `POST /servers/{id}/poweron`
Powers on the server.

### `POST /servers/{id}/change-ip`
Replaces the current Hetzner Primary IPv4 with a newly allocated IPv4. The operation can temporarily power the server off and back on.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/change-ip \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

Success:

```json
{
  "ok": true,
  "status": "ip_changed",
  "old_ip": "203.0.113.10",
  "new_ip": "203.0.113.24"
}
```

### `DELETE /servers/{id}`
Permanently deletes a server through the HamoonCloud lifecycle service.

Direct reboot is not advertised in v1 and currently returns `501 UNSUPPORTED_ACTION`.

## Management endpoint summary

| Feature | Method | Endpoint |
|---|---|---|
| Rename/display name | `PATCH` | `/servers/{id}/name` |
| Reset root password | `POST` | `/servers/{id}/reset-password` |
| Create snapshot | `POST` | `/servers/{id}/snapshots` |
| List snapshots | `GET` | `/servers/{id}/snapshots` |
| Rebuild | `POST` | `/servers/{id}/rebuild` |
| Upgrade / Resize | `POST` | `/servers/{id}/upgrade` |
| Traffic usage | `GET` | `/servers/{id}/traffic` |
| Power on | `POST` | `/servers/{id}/poweron` |
| Power off | `POST` | `/servers/{id}/poweroff` |
| Change IPv4 | `POST` | `/servers/{id}/change-ip` |
| Delete server | `DELETE` | `/servers/{id}` |

## Errors

Errors use this shape:

```json
{
  "ok": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "..."
  }
}
```

Common codes include `AUTH_REQUIRED`, `INVALID_API_KEY`, `NOT_ALLOWED`, `SERVER_NOT_FOUND`, `SERVER_STATE_CONFLICT`, `OPERATION_IN_PROGRESS`, `RATE_LIMITED`, `IMAGE_REQUIRED`, `NAME_REQUIRED`, `NAME_TOO_LONG`, `ROOT_PASSWORD_UNAVAILABLE`, and provider-specific errors.

Every API response includes an `X-Request-Id` header for troubleshooting.

## Rate limits

- Read requests: up to 60 requests/minute per API key.
- Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`): up to 10 requests/minute per API key.

## Security requirements

- Keep the API key only in backend/server-side secrets.
- Never expose the API key in frontend JavaScript, mobile apps or public source code.
- Treat `root_password` as a secret and never write it to application logs.
- Use HTTPS only.
- Rotate an API key immediately if it is exposed.
- Rebuild and delete are destructive operations and should require explicit confirmation in the reseller UI.
