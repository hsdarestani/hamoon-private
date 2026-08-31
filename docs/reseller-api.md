# HamoonCloud Reseller API v1

Production Base URL:

```text
https://pay.hamooncloud.ir/api/v1
```

All requests and responses use JSON. API keys must only be stored on the reseller backend/server and must never be exposed in browser/mobile frontend code.

## Authentication

Send the reseller key as a Bearer token:

```http
Authorization: Bearer hm_live_xxxxxxxxxxxxxxxxx
```

Example:

```bash
curl https://pay.hamooncloud.ir/api/v1/me \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

A missing/invalid key returns HTTP `401`.

## Quick start

1. Call `GET /me` to verify the API key and account limits.
2. Call `GET /wallet` to check reseller wallet balance.
3. Call `GET /prices` to fetch currently sellable plans and reseller prices.
4. Call `POST /servers` to create a server.
5. Poll `GET /servers/{id}` until the provider status/IP is available.
6. Manage the server with power on/off, IP change or delete endpoints.

## Endpoints

### Account

#### `GET /me`
Returns the authenticated reseller API client and configured limits.

```bash
curl https://pay.hamooncloud.ir/api/v1/me \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

#### `GET /wallet`
Returns current reseller wallet balance.

```bash
curl https://pay.hamooncloud.ir/api/v1/wallet \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

#### `GET /usage`
Returns API-client usage summary.

#### `GET /prices`
Returns currently sellable Hetzner plans and reseller prices.

```bash
curl https://pay.hamooncloud.ir/api/v1/prices \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

Always use prices returned by this endpoint instead of hard-coding them.

### Servers

#### `GET /servers`
Returns servers owned by this reseller account.

```bash
curl https://pay.hamooncloud.ir/api/v1/servers \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

#### `GET /servers/{id}`
Returns the reseller purchase record and, when available, current provider information such as status, public IPv4, server type and location.

```bash
curl https://pay.hamooncloud.ir/api/v1/servers/123456 \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

#### `POST /servers`
Creates a new server. JSON body is recommended. Query parameters are also accepted for backward compatibility; if both are sent, JSON body values win.

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

Supported input fields:

| Field | Required | Notes |
|---|---:|---|
| `server_type` | yes | Use an ID/type returned by `GET /prices` |
| `name` | no | Server name, sanitized to provider-safe characters |
| `image` | no | Default: `ubuntu-24.04`; must be allowed for the reseller |
| `location` | no | Must be an allowed location |
| `duration` | no | `hourly` or `monthly`; default: `hourly` |
| `datacenter` | no | Current reseller production scope is Hetzner |
| `ssh_key` | no | Public SSH key, max 4096 characters |

Successful creation returns HTTP `202`. Provisioning is asynchronous. Example shape (the `price` value is illustrative only):

```json
{
  "ok": true,
  "operation": "provisioning",
  "server": {
    "id": "123456",
    "name": "customer-001",
    "status": "provisioning",
    "public_ip": "203.0.113.10",
    "server_type": "cpx22",
    "image": "ubuntu-24.04",
    "location": "nbg1",
    "duration": "monthly",
    "price": 350000
  }
}
```

`public_ip` can still be `null` during early provisioning. Poll `GET /servers/{id}` instead of assuming the IP is immediately ready.

The API checks account permissions, wallet balance/reserve, server count limit and configured spending limits before creating a server. If provider creation succeeds but the local purchase record cannot be saved, the API performs a best-effort cleanup of the provider-side server.

#### `POST /servers/{id}/poweroff`
Turns off/suspends a server owned by the reseller account.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/poweroff \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

#### `POST /servers/{id}/poweron`
Turns on/resumes a server owned by the reseller account.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/poweron \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

#### `POST /servers/{id}/change-ip`
Replaces the current Hetzner Primary IPv4 with a newly allocated IPv4. The operation temporarily powers the server off, swaps the Primary IP, powers the server back on and persists the new public IP. If the swap fails after a candidate IP is allocated, the service attempts to restore the previous IP automatically.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/change-ip \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

Successful response:

```json
{
  "ok": true,
  "status": "ip_changed",
  "old_ip": "203.0.113.10",
  "new_ip": "203.0.113.24"
}
```

Manual API IP change is allowed only while the purchase is in `active`, `running`, `suspended`, `stopped` or `shutoff` state. Concurrent lifecycle operations return HTTP `409`.

#### `DELETE /servers/{id}`
Permanently deletes a server through the HamoonCloud lifecycle service.

```bash
curl -X DELETE https://pay.hamooncloud.ir/api/v1/servers/123456 \
  -H "Authorization: Bearer $HAMOON_API_KEY"
```

### Optional management endpoint

#### `POST /servers/{id}/upgrade`
Changes the server type to another allowed plan.

```bash
curl -X POST https://pay.hamooncloud.ir/api/v1/servers/123456/upgrade \
  -H "Authorization: Bearer $HAMOON_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"target_server_type":"cpx32","upgrade_disk":false}'
```

Direct reboot is not advertised in v1 and currently returns `501 UNSUPPORTED_ACTION` rather than reporting a fake successful operation.

## Common errors

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

Common codes:

| HTTP | Code | Meaning |
|---:|---|---|
| 401 | `AUTH_REQUIRED` | Bearer API key missing |
| 401 | `INVALID_API_KEY` | Key invalid, revoked or inactive |
| 402 | `INSUFFICIENT_WALLET` | Wallet does not cover the server price plus configured reserve |
| 403 | `NOT_ALLOWED` | Plan/image/location not allowed for this reseller |
| 403 | `SERVER_LIMIT_REACHED` | Maximum active server count reached |
| 403 | `MONTHLY_SPEND_LIMIT_REACHED` | Configured monthly spending limit reached |
| 403 | `HOURLY_SPEND_LIMIT_REACHED` | Requested hourly plan exceeds configured limit |
| 404 | `SERVER_NOT_FOUND` | Server is not owned by this reseller account or does not exist |
| 409 | `HETZNER_PLACEMENT_UNAVAILABLE` | Provider cannot currently place the requested server |
| 409 | `OPERATION_IN_PROGRESS` | Another lifecycle operation is already active |
| 409 | `SERVER_STATE_CONFLICT` | Current server state does not allow the requested operation |
| 409 | `NO_UNUSED_PRIMARY_IPV4_AVAILABLE` | Hetzner did not return a usable IP candidate outside the reuse cooldown |
| 429 | `RATE_LIMITED` | Request rate exceeded |
| 501 | `UNSUPPORTED_ACTION` | Endpoint/action intentionally not available in v1 |
| 502 | `PRIMARY_IPV4_NOT_FOUND` | Current Primary IPv4 information could not be resolved from Hetzner |
| 502 | `OLD_PRIMARY_IP_CLEANUP_FAILED` | IP swap cleanup failed and rollback was attempted |
| 504 | `NEW_IP_NOT_READY` | New IP did not become ready before the operation timeout |

Every API response includes an `X-Request-Id` header for troubleshooting.

## Rate limits

Current application-level limits are conservative per API key:

- Read requests: up to 60 requests/minute.
- Mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`): up to 10 requests/minute.

Contact HamoonCloud before designing integrations that require higher sustained rates.

## Security requirements for resellers

- Keep the API key only in backend/server-side secrets.
- Never ship it inside JavaScript bundles, Android/iOS apps, public repositories or customer-visible responses.
- Use HTTPS production URL only.
- Give each reseller its own API client and key; never share one key between unrelated resellers.
- Revoke and rotate a key immediately if it is exposed.
- Do not expose provider credentials or HamoonCloud internal credentials to end customers.

## Recommended reseller flow

Your customer pays you -> your backend checks HamoonCloud price/balance -> your backend calls `POST /servers` -> save the returned server ID -> poll `GET /servers/{id}` -> show only the customer-facing server information in your own panel/bot.

The final resale price is controlled by the reseller. HamoonCloud API returns the configured reseller/base price; any markup or customer billing logic belongs to the reseller application.
