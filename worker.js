
const express = require("express");
const { Redis } = require("@upstash/redis");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;
const RXDZ_API_KEY = process.env.RXDZ_API_KEY;

const redis = Redis.fromEnv();
const QUEUE_KEY = "rxdz:queue";

if (!TIKTOK_USERNAME || !RXDZ_API_KEY) {
  throw new Error("Missing TIKTOK_USERNAME or RXDZ_API_KEY in Railway variables.");
}

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Roblox pulls queued viewers from this endpoint
app.get("/api/roblox/pull", async (req, res) => {
  if (req.get("X-API-Key") !== RXDZ_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsed = Number.parseInt(String(req.query.max ?? "3"), 10);
  const max = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), 20)
    : 3;

  try {
    const viewers = [];

    for (let i = 0; i < max; i++) {
      const item = await redis.rpop(QUEUE_KEY);
      if (!item) break;

      viewers.push(typeof item === "string" ? JSON.parse(item) : item);
    }

    return res.json({ viewers });
  } catch (error) {
    console.error("Redis pull error:", error);
    return res.status(500).json({ error: "queue_error" });
  }
});

app.listen(PORT, () => {
  console.log(`RXDZ LIVE server listening on port ${PORT}`);
});

// TikTok LIVE connection
const connection = new TikTokLiveConnection(TIKTOK_USERNAME);

connection.on(WebcastEvent.CHAT, async (data) => {
  const comment = String(data.comment ?? data.content ?? "").trim();

  const tiktokName =
    data.user?.displayId ||
    data.user?.uniqueId ||
    data.user?.nickname ||
    "TikTokUser";

  console.log(`TikTok comment received from @${tiktokName}: ${comment}`);

  // New command: /RobloxUsername
  const match = comment.match(/^\/([A-Za-z0-9_]{3,20})$/);

  if (!match) return;

  const robloxName = match[1];

  try {
    const viewer = {
      tiktok: tiktokName,
      roblox: robloxName,
      receivedAt: new Date().toISOString()
    };

    await redis.lpush(QUEUE_KEY, JSON.stringify(viewer));

    console.log(
      `Queued TikTok @${tiktokName} -> Roblox ${robloxName}`
    );
  } catch (error) {
    console.error("Could not add viewer to Redis queue:", error);
  }
});

connection.connect()
  .then((state) => {
    console.log(`Connected to TikTok LIVE: @${TIKTOK_USERNAME}`);
    console.log("TikTok connection state:", state);
  })
  .catch((error) => {
    console.error("TikTok connection failed:", error);
  });

connection.on(WebcastEvent.DISCONNECTED, () => {
  console.warn("TikTok LIVE disconnected. Check Railway logs.");
});

connection.on(WebcastEvent.ERROR, (error) => {
  console.error("TikTok connection error:", error);
});
