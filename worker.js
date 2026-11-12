
import express from "express";
import { Redis } from "@upstash/redis";
import {
  TikTokLiveConnection,
  WebcastEvent,
} from "tiktok-live-connector";

const {
  TIKTOK_USERNAME,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  RXDZ_API_KEY,
  PORT = "8080",
} = process.env;

// Check required environment variables
const required = [
  ["TIKTOK_USERNAME", TIKTOK_USERNAME],
  ["UPSTASH_REDIS_REST_URL", UPSTASH_REDIS_REST_URL],
  ["UPSTASH_REDIS_REST_TOKEN", UPSTASH_REDIS_REST_TOKEN],
  ["RXDZ_API_KEY", RXDZ_API_KEY],
];

const missing = required
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(
    `Missing environment variables: ${missing.join(", ")}`
  );
  process.exit(1);
}

// Redis connection
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const QUEUE_KEY = "rxdz:queue";

// Express API
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Roblox pulls viewers from this endpoint
app.get("/api/roblox/pull", async (req, res) => {
  if (req.get("X-API-Key") !== RXDZ_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const parsed = Number.parseInt(
    String(req.query.max ?? "3"),
    10
  );

  const max = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), 20)
    : 3;

  try {
    const viewers = [];

    for (let i = 0; i < max; i += 1) {
      const item = await redis.rpop(QUEUE_KEY);

      if (!item) break;

      viewers.push(
        typeof item === "string" ? JSON.parse(item) : item
      );
    }

    return res.json({ viewers });
  } catch (error) {
    console.error("Queue read failed:", error);

    return res.status(500).json({
      error: "queue_read_failed",
    });
  }
});

// Start HTTP server
const server = app.listen(
  Number(PORT),
  "0.0.0.0",
  () => {
    console.log(
      `RXDZ worker API listening on port ${PORT}`
    );
  }
);

// TikTok connection
const connection = new TikTokLiveConnection(
  TIKTOK_USERNAME,
  {
    processInitialData: false,
    enableExtendedGiftInfo: false,
  }
);

// Parse /RX RobloxUsername
function parseJoinCommand(comment) {
  const match = String(comment ?? "")
    .trim()
    .match(/^\/RX\s+([A-Za-z0-9_]{3,20})$/i);

  return match ? match[1] : null;
}

// Receive TikTok comments
connection.on(WebcastEvent.CHAT, async (data) => {
  try {
    const robloxName = parseJoinCommand(data.comment);

    if (!robloxName) return;

    const tiktokName =
      data.user?.uniqueId ||
      data.user?.nickname ||
      "TikTokUser";

    const entry = {
      tiktok: String(tiktokName).slice(0, 40),
      roblox: robloxName,
      receivedAt: new Date().toISOString(),
    };

    await redis.lpush(
      QUEUE_KEY,
      JSON.stringify(entry)
    );

    console.log(
      `Queued TikTok @${entry.tiktok} -> Roblox ${entry.roblox}`
    );
  } catch (error) {
    console.error(
      "Could not process TikTok comment:",
      error
    );
  }
});

// TikTok error events
connection.on("error", (error) => {
  console.error("TikTok connection error:", error);
});

// Delay helper
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep TikTok connected and retry when needed
async function keepTikTokConnected() {
  while (true) {
    try {
      if (!connection.isConnected) {
        console.log(
          `Waiting for TikTok LIVE: @${TIKTOK_USERNAME}`
        );

        // Wait until TikTok detects the LIVE stream
        await connection.waitUntilLive(60);

        console.log("TikTok LIVE detected. Connecting...");

        await connection.connect();

        console.log(
          `Connected to TikTok LIVE: @${TIKTOK_USERNAME}`
        );
      }

      // Wait until the connection is disconnected
      await new Promise((resolve) => {
        connection.once("disconnected", resolve);
      });

      console.log(
        "TikTok disconnected. Reconnecting..."
      );

      await delay(30000);
    } catch (error) {
      console.error(
        "TikTok connection attempt failed:",
        error
      );

      console.log(
        "Will retry in 60 seconds..."
      );

      await delay(60000);
    }
  }
}

// Start connection manager
keepTikTokConnected().catch((error) => {
  console.error("TikTok connection manager stopped:", error);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down RXDZ worker...");

  try {
    await connection.disconnect();
  } catch (error) {
    console.error("Disconnect error:", error);
  }

  server.close(() => {
    process.exit(0);
  });
});
