// Key policy and demo rate limiting for hosted deployments.
//
// KEY_MODE decides whether visitors may spend the API keys in the server's
// environment:
//   open (default) - env keys fill in whenever the client omits one
//   demo           - env keys work, but model turns are rate limited
//   byok           - env keys are never used; visitors bring their own key
//
// In every mode an env key is only attached when the request targets that
// provider's trusted base URL (the provider preset, or the operator's own
// LLM_BASE_URL). A client-supplied base URL therefore can never redirect a
// server key to an attacker's endpoint.

import { getProviderDefinition, getProviderApiKey, normalizeBaseUrl } from "./providers.js";

const KEY_MODES = new Set(["open", "demo", "byok"]);

export function normalizeKeyMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return KEY_MODES.has(mode) ? mode : "open";
}

export function createKeyPolicy({ keyMode, startup, env = process.env }) {
  const mode = normalizeKeyMode(keyMode);

  const trustedBaseUrls = (provider) => {
    const urls = [getProviderDefinition(provider).defaultBaseUrl];
    if (provider === startup.provider) urls.push(startup.apiBaseUrl);
    return urls.map((url) => normalizeBaseUrl(url, url));
  };

  return {
    mode,
    // The env key for client-driven requests, or "" when policy forbids it.
    serverKeyFor(provider, baseUrl) {
      if (mode === "byok") return "";
      if (!trustedBaseUrls(provider).includes(normalizeBaseUrl(baseUrl, baseUrl))) return "";
      return getProviderApiKey(provider, env);
    },
    serverKeyAvailable(provider) {
      return mode !== "byok" && Boolean(getProviderApiKey(provider, env));
    },
  };
}

// Fixed-window counters: per-IP turns per hour plus a global daily budget.
// In-memory on purpose; a single-instance hobby deploy does not need more.
export function createDemoLimiter({ turnsPerIpPerHour, turnsPerDay, now = Date.now }) {
  const HOUR_MS = 3_600_000;
  const DAY_MS = 24 * HOUR_MS;
  const ipWindows = new Map();
  let globalWindow = { start: 0, count: 0 };

  const roll = (window, length, at) =>
    at - window.start >= length ? { start: at, count: 0 } : window;

  return {
    take(ip) {
      const at = now();
      globalWindow = roll(globalWindow, DAY_MS, at);
      if (globalWindow.count >= turnsPerDay) return { ok: false, reason: "day" };

      const key = ip || "unknown";
      const window = roll(ipWindows.get(key) || { start: at, count: 0 }, HOUR_MS, at);
      if (window.count >= turnsPerIpPerHour) return { ok: false, reason: "ip" };

      window.count += 1;
      ipWindows.set(key, window);
      globalWindow.count += 1;

      if (ipWindows.size > 1000) {
        for (const [k, w] of ipWindows) {
          if (at - w.start >= HOUR_MS) ipWindows.delete(k);
        }
      }
      return { ok: true };
    },
  };
}

export function clientIp(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || "";
}
