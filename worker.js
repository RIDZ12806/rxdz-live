
import express from "express";
import { Redis } from "@upstash/redis";
import {
  TikTokLiveConnection,
  WebcastEvent,
} from "tiktok-live-connector";
import crypto from "node:crypto";

// Environment variables
const {
  TIKTOK_USERNAME,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  RXDZ_API_KEY,
  RXDZ_ADMIN_PASSWORD,
  RXDZ_SESSION_SECRET,
  RXDZ_FRONTEND_ORIGIN,
  PORT = "8080",
} = process.env;

const required = [
  ["TIKTOK_USERNAME", TIKTOK_USERNAME],
  ["UPSTASH_REDIS_REST_URL", UPSTASH_REDIS_REST_URL],
  ["UPSTASH_REDIS_REST_TOKEN", UPSTASH_REDIS_REST_TOKEN],
  ["RXDZ_API_KEY", RXDZ_API_KEY],
  ["RXDZ_ADMIN_PASSWORD", RXDZ_ADMIN_PASSWORD],
  ["RXDZ_SESSION_SECRET", RXDZ_SESSION_SECRET],
  ["RXDZ_FRONTEND_ORIGIN", RXDZ_FRONTEND_ORIGIN],
];

const missing = required
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length) {
  console.error("Missing variables:", missing.join(", "));
  process.exit(1);
}

if (RXDZ_SESSION_SECRET.length < 32) {
  console.error("RXDZ_SESSION_SECRET must be at least 32 characters.");
  process.exit(1);
}

// Pin the production GitHub Pages origin to avoid stale/mismatched Railway env values.
const FRONTEND_ORIGIN = "https://ridz12806.github.io";
const SESSION_COOKIE = "rxdz_admin_session";
const SESSION_DURATION = 12 * 60 * 60 * 1000;

const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

const QUEUE_KEY = "rxdz:queue";
const DEMO_CONFIG_KEY = "rxdz:demo:config";

const DEFAULT_NAMES = [
  "Builderman", "Guest", "Bacon", "Noob",
  "Pro", "Admin", "John", "Jane",
  "Robloxian", "CoolKid", "Ninja", "Warrior",
  "Dragon", "Shadow", "Legend", "Hero",
  "Champion", "Master", "King", "Queen",
  "Explorer", "Gamer", "Pilot", "Knight",
];

const app = express();

// CORS: allow only the configured Netlify site
app.use((req, res, next) => {
  const origin = req.get("Origin");

  if (origin === FRONTEND_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", FRONTEND_ORIGIN);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-API-Key, X-Admin-Token"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, OPTIONS"
    );
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    if (origin !== FRONTEND_ORIGIN) {
      return res.sendStatus(403);
    }
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "20kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Session helpers
function signSession(expiry) {
  return crypto
    .createHmac("sha256", RXDZ_SESSION_SECRET)
    .update(String(expiry))
    .digest("hex");
}

function safeEqual(a, b) {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim());

  const entry = cookies.find((part) =>
    part.startsWith(`${name}=`)
  );

  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function isAuthenticated(req) {
  // Prefer an explicit bearer-style header for browsers that block
  // cross-site cookies; retain cookie support for existing clients.
  const headerToken = req.get("X-Admin-Token");
  const token = headerToken || getCookie(req, SESSION_COOKIE);
  if (!token) return false;

  const [expiryText, signature] = token.split(".");
  const expiry = Number(expiryText);

  if (!Number.isFinite(expiry) || expiry < Date.now()) {
    return false;
  }

  return safeEqual(signature || "", signSession(expiry));
}

function requireFrontend(req, res, next) {
  if (req.get("Origin") !== FRONTEND_ORIGIN) {
    return res.status(403).json({ error: "origin_not_allowed" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "login_required" });
  }
  next();
}

function requireRobloxKey(req, res, next) {
  if (req.get("X-API-Key") !== RXDZ_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function defaultDemoConfig() {
  return {
    enabled: false,
    names: DEFAULT_NAMES,
    updatedAt: new Date().toISOString(),
  };
}

async function getDemoConfig() {
  const stored = await redis.get(DEMO_CONFIG_KEY);

  if (!stored) return defaultDemoConfig();

  return typeof stored === "string"
    ? JSON.parse(stored)
    : stored;
}

// Admin login
app.post(
  "/api/admin/login",
  requireFrontend,
  async (req, res) => {
    const password = String(req.body?.password || "");

    if (!safeEqual(password, RXDZ_ADMIN_PASSWORD)) {
      return res.status(401).json({ error: "invalid_password" });
    }

    const expiry = Date.now() + SESSION_DURATION;
    const token = `${expiry}.${signSession(expiry)}`;

    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: SESSION_DURATION,
      path: "/",
    });

    // Also return the signed session token for clients that cannot persist
    // third-party cookies. The frontend stores it and sends X-Admin-Token.
    return res.json({ ok: true, token });
  }
);

// Check current login
app.get(
  "/api/admin/me",
  requireFrontend,
  (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
  }
);

// Admin logout
app.post(
  "/api/admin/logout",
  requireFrontend,
  (_req, res) => {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
    });

    res.json({ ok: true });
  }
);

// Read demo settings
app.get(
  "/api/admin/config",
  requireFrontend,
  requireAdmin,
  async (_req, res) => {
    try {
      res.json(await getDemoConfig());
    } catch (error) {
      console.error("Could not read demo config:", error);
      res.status(500).json({ error: "config_read_failed" });
    }
  }
);

// Save demo settings
app.put(
  "/api/admin/config",
  requireFrontend,
  requireAdmin,
  async (req, res) => {
    try {
      const names = req.body?.names;
      const enabled = req.body?.enabled;

      if (
        !Array.isArray(names) ||
        names.length < 1 ||
        names.length > 100 ||
        names.some(
          (name) =>
            typeof name !== "string" ||
            !/^[A-Za-z0-9_]{3,20}$/.test(name)
        ) ||
        typeof enabled !== "boolean"
      ) {
        return res.status(400).json({
          error: "invalid_demo_config",
        });
      }

      const config = {
        enabled,
        names,
        updatedAt: new Date().toISOString(),
      };

      await redis.set(DEMO_CONFIG_KEY, JSON.stringify(config));

      return res.json({ ok: true, config });
    } catch (error) {
      console.error("Could not save demo config:", error);
      return res.status(500).json({ error: "config_save_failed" });
    }
  }
);

// Roblox reads demo settings using its private API key
app.get(
  "/api/roblox/control",
  requireRobloxKey,
  async (_req, res) => {
    try {
      const config = await getDemoConfig();
      res.json(config);
    } catch (error) {
      console.error("Could not read Roblox control:", error);
      res.status(500).json({ error: "control_read_failed" });
    }
  }
);

// Existing Roblox viewer queue endpoint
app.get("/api/roblox/pull", requireRobloxKey, async (req, res) => {
  const parsed = Number.parseInt(String(req.query.max ?? "3"), 10);

  const max = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, 1), 20)
    : 3;

  try {
    const viewers = [];

    for (let i = 0; i < max; i++) {
      const item = await redis.rpop(QUEUE_KEY);
      if (!item) break;

      viewers.push(
        typeof item === "string" ? JSON.parse(item) : item
      );
    }

    return res.json({ viewers });
  } catch (error) {
    console.error("Redis queue error:", error);
    return res.status(500).json({ error: "queue_read_failed" });
  }
});

// Start server
const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`RXDZ worker API listening on port ${PORT}`);
});

// TikTok connection
const connection = new TikTokLiveConnection(TIKTOK_USERNAME, {
  processInitialData: false,
  enableExtendedGiftInfo: false,
});

// Username-only join command
function parseJoinCommand(comment) {
  const match = String(comment ?? "")
    .trim()
    .match(/^([A-Za-z0-9_]{3,20})$/);

  return match ? match[1] : null;
}

// Receive TikTok chat
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

    await redis.lpush(QUEUE_KEY, JSON.stringify(entry));

    console.log(
      `Queued TikTok @${entry.tiktok} -> Roblox ${entry.roblox}`
    );
  } catch (error) {
    console.error("Could not process TikTok comment:", error);
  }
});

connection.on("error", (error) => {
  console.error("TikTok connection error:", error);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let stopping = false;

async function keepTikTokConnected() {
  while (!stopping) {
    try {
      if (!connection.isConnected) {
        console.log(`Waiting for TikTok LIVE: @${TIKTOK_USERNAME}`);
        await connection.waitUntilLive(60);

        if (stopping) break;

        console.log("TikTok LIVE detected. Connecting...");
        await connection.connect();

        console.log(`Connected to TikTok LIVE: @${TIKTOK_USERNAME}`);
      }

      await new Promise((resolve) => {
        connection.once("disconnected", resolve);
      });

      if (!stopping) {
        console.log("TikTok disconnected. Reconnecting...");
        await delay(30000);
      }
    } catch (error) {
      if (stopping) break;

      console.error("TikTok connection attempt failed:", error);
      console.log("Retrying in 60 seconds...");
      await delay(60000);
    }
  }
}

keepTikTokConnected().catch((error) => {
  console.error("Connection manager error:", error);
});

async function shutdown() {
  if (stopping) return;

  stopping = true;
  console.log("Shutting down RXDZ worker...");

  try {
    await connection.disconnect();
  } catch (error) {
    console.error("Disconnect error:", error);
  }

  server.close(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
