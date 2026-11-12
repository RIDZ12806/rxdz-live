import express from "express";
import { Redis } from "@upstash/redis";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";

const {
  TIKTOK_USERNAME,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  RXDZ_API_KEY,
  PORT = "3000",
} = process.env;

const required = [
  ["TIKTOK_USERNAME", TIKTOK_USERNAME],
  ["UPSTASH_REDIS_REST_URL", UPSTASH_REDIS_REST_URL],
  ["UPSTASH_REDIS_REST_TOKEN", UPSTASH_REDIS_REST_TOKEN],
  ["RXDZ_API_KEY", RXDZ_API_KEY],
];
const missing = required.filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const QUEUE_KEY = "rxdz:queue";
const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/roblox/pull", async (req, res) => {
  if (req.get("X-API-Key") !== RXDZ_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsed = Number.parseInt(String(req.query.max ?? "3"), 10);
  const max = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 20) : 3;

  try {
    const viewers = [];
    for (let i = 0; i < max; i += 1) {
      const item = await redis.rpop(QUEUE_KEY);
      if (!item) break;
      viewers.push(typeof item === "string" ? JSON.parse(item) : item);
    }
    return res.json({ viewers });
  } catch (error) {
    console.error("Queue read failed:", error);
    return res.status(500).json({ error: "queue_read_failed" });
  }
});

const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`RXDZ worker API listening on port ${PORT}`);
});

const connection = new TikTokLiveConnection(TIKTOK_USERNAME, {
  processInitialData: false,
  enableExtendedGiftInfo: false,
});

function parseJoinCommand(comment) {
  const match = String(comment ?? "").trim().match(/^\/RX\s+([A-Za-z0-9_]{3,20})$/i);
  return match ? match[1] : null;
}

connection.on(WebcastEvent.CHAT, async (data) => {
  try {
    const robloxName = parseJoinCommand(data.comment);
    if (!robloxName) return;

    const tiktokName = data.user?.uniqueId || data.user?.nickname || "TikTokUser";
    const entry = {
      tiktok: String(tiktokName).slice(0, 40),
      roblox: robloxName,
      receivedAt: new Date().toISOString(),
    };

    await redis.lpush(QUEUE_KEY, JSON.stringify(entry));
    console.log(`Queued TikTok @${entry.tiktok} -> Roblox ${entry.roblox}`);
  } catch (error) {
    console.error("Could not process TikTok comment:", error);
  }
});

connection.on("error", (error) => console.error("TikTok connection error:", error));

try {
  await connection.connect();
  console.log(`Connected to TikTok LIVE: @${TIKTOK_USERNAME}`);
} catch (error) {
  console.error("Could not connect to TikTok LIVE:", error);
  console.error("Check that the account is LIVE and TIKTOK_USERNAME is its handle without @.");
}

process.on("SIGTERM", async () => {
  try { await connection.disconnect(); } catch {}
  server.close(() => process.exit(0));
});
