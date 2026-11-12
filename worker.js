
import express from "express";
import { Redis } from "@upstash/redis";
import {
  TikTokLiveConnection,
  WebcastEvent,
} from "tiktok-live-connector";

// Environment variables
const {
  TIKTOK_USERNAME,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  RXDZ_API_KEY,
  PORT = "8080",
} = process.env;

// Validate configuration
const required = [
  ["TIKTOK_USERNAME", TIKTOK_USERNAME],
  ["UPSTASH_REDIS_REST_URL", UPSTASH_REDIS_REST_URL],
  ["UPSTASH_REDIS_REST_TOKEN", UPSTASH_REDIS_REST_TOKEN],
  ["RXDZ_API_KEY", RXDZ_API_KEY],
];

const missing = required
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length) {
  console.error("Missing variables:", missing.join(", "));
  process.exit(1);
}

// Redis
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const QUEUE_KEY = "rxdz:queue";

// HTTP API
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Roblox queue endpoint
app.get("/api/roblox/pull", async (req, res) => {
  if (req.get("X-API-Key") !== RXDZ_API_KEY) {
    return res.status(401).json({
      error: "unauthorized",
    });
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

    for (let i = 0; i < max; i++) {
      const item = await redis.rpop(QUEUE_KEY);

      if (!item) break;

      viewers.push(
        typeof item === "string"
          ? JSON.parse(item)
          : item
      );
    }

    return res.json({ viewers });
  } catch (error) {
    console.error("Redis queue error:", error);

    return res.status(500).json({
      error: "queue_read_failed",
    });
  }
});

// Start server
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

// New command: /RobloxUsername
function parseJoinCommand(comment) {
  const match = String(comment ?? "")
    .trim()
    .match(/^\/([A-Za-z0-9_]{3,20})$/);

  return match ? match[1] : null;
}

// Receive chat events
connection.on(WebcastEvent.CHAT, async (data) => {
  try {
    const comment = String(
      data.content ?? data.comment ?? ""
    ).trim();

    const tiktokName =
      data.user?.displayId ||
      data.user?.uniqueId ||
      data.user?.nickname ||
      "TikTokUser";

    console.log(
      `TikTok comment received from @${tiktokName}: ${comment}`
    );

    const robloxName = parseJoinCommand(comment);

    if (!robloxName) return;

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

// Connection error events
connection.on("error", (error) => {
  console.error("TikTok connection error:", error);
});

// Delay helper
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Connection manager
let stopping = false;

async function keepTikTokConnected() {
  while (!stopping) {
    try {
      if (!connection.isConnected) {
        console.log(
          `Waiting for TikTok LIVE: @${TIKTOK_USERNAME}`
        );

        await connection.waitUntilLive(60);

        if (stopping) break;

        console.log("TikTok LIVE detected. Connecting...");

        await connection.connect();

        console.log(
          `Connected to TikTok LIVE: @${TIKTOK_USERNAME}`
        );
      }

      await new Promise((resolve) => {
        connection.once("disconnected", resolve);
      });

      if (!stopping) {
        console.log(
          "TikTok disconnected. Reconnecting..."
        );

        await delay(30000);
      }
    } catch (error) {
      if (stopping) break;

      console.error(
        "TikTok connection attempt failed:",
        error
      );

      console.log("Retrying in 60 seconds...");
      await delay(60000);
    }
  }
}

// Start TikTok connection
keepTikTokConnected().catch((error) => {
  console.error(
    "Connection manager error:",
    error
  );
});

// Graceful shutdown
async function shutdown() {
  if (stopping) return;

  stopping = true;

  console.log("Shutting down RXDZ worker...");

  try {
    await connection.disconnect();
  } catch (error) {
    console.error("Disconnect error:", error);
  }

  server.close(() => {
    process.exit(0);
  });
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
