# RXDZ LIVE Worker

Reads TikTok LIVE comments and queues Roblox usernames in Upstash Redis.

## Comment format
`/RX RobloxUsername`

Example: `/RX Builderman`

Only 3–20 English letters, digits, and underscores are accepted. TikTok handle and Roblox username are stored separately.

## Railway Variables
- `TIKTOK_USERNAME` — TikTok LIVE handle, without `@`.
- `UPSTASH_REDIS_REST_URL` — Upstash Redis REST URL.
- `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis REST token.
- `RXDZ_API_KEY` — secret matching the Roblox poller's `X-API-Key` header.
- `PORT` — normally supplied by Railway automatically.

Never put secret values in GitHub.

## Roblox endpoint
`GET /api/roblox/pull?max=3` with header `X-API-Key: your-secret`

Response:
```json
{"viewers":[{"tiktok":"viewer_handle","roblox":"RobloxUsername","receivedAt":"..."}]}
```

This matches the existing Roblox poller response shape.

## Notes
The TikTok connector is an unofficial community library; TikTok protocol changes or restrictions may interrupt connectivity. This worker does not edit Roblox scripts or maps.
