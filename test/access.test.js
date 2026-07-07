import test from "node:test";
import assert from "node:assert/strict";

import { normalizeKeyMode, createKeyPolicy, createDemoLimiter, clientIp } from "../lib/access.js";

const STARTUP = { provider: "openai", apiBaseUrl: "https://api.openai.com/v1" };
const ENV = { OPENAI_API_KEY: "sk-openai", ANTHROPIC_API_KEY: "sk-anthropic" };

test("normalizeKeyMode falls back to open", () => {
  assert.equal(normalizeKeyMode("demo"), "demo");
  assert.equal(normalizeKeyMode(" BYOK "), "byok");
  assert.equal(normalizeKeyMode("banana"), "open");
  assert.equal(normalizeKeyMode(""), "open");
});

test("server key is only attached on the provider's trusted base URL", () => {
  const policy = createKeyPolicy({ keyMode: "open", startup: STARTUP, env: ENV });

  assert.equal(policy.serverKeyFor("openai", "https://api.openai.com/v1"), "sk-openai");
  assert.equal(policy.serverKeyFor("openai", "https://api.openai.com/v1/"), "sk-openai");
  // The exfiltration case: client points the provider at their own host.
  assert.equal(policy.serverKeyFor("openai", "https://evil.example.com/v1"), "");
  // Cross-provider default URLs are not trusted either.
  assert.equal(policy.serverKeyFor("openai", "https://api.anthropic.com/v1"), "");
  assert.equal(policy.serverKeyFor("anthropic", "https://api.anthropic.com/v1"), "sk-anthropic");
});

test("the operator's own LLM_BASE_URL is trusted for the startup provider", () => {
  const startup = { provider: "custom", apiBaseUrl: "https://gateway.example.com/v1" };
  const policy = createKeyPolicy({
    keyMode: "open",
    startup,
    env: { LLM_API_KEY: "sk-gateway" },
  });

  assert.equal(policy.serverKeyFor("custom", "https://gateway.example.com/v1"), "sk-gateway");
  assert.equal(policy.serverKeyFor("custom", "https://other.example.com/v1"), "");
  // Another provider does not inherit the startup URL's trust.
  assert.equal(policy.serverKeyFor("openai", "https://gateway.example.com/v1"), "");
});

test("byok mode never uses server keys", () => {
  const policy = createKeyPolicy({ keyMode: "byok", startup: STARTUP, env: ENV });

  assert.equal(policy.serverKeyFor("openai", "https://api.openai.com/v1"), "");
  assert.equal(policy.serverKeyAvailable("openai"), false);
});

test("serverKeyAvailable reports configured keys outside byok", () => {
  const policy = createKeyPolicy({ keyMode: "demo", startup: STARTUP, env: ENV });

  assert.equal(policy.serverKeyAvailable("openai"), true);
  assert.equal(policy.serverKeyAvailable("llama"), false);
});

test("demo limiter enforces the per-IP hourly window", () => {
  let at = 0;
  const limiter = createDemoLimiter({ turnsPerIpPerHour: 2, turnsPerDay: 100, now: () => at });

  assert.equal(limiter.take("1.1.1.1").ok, true);
  assert.equal(limiter.take("1.1.1.1").ok, true);
  assert.deepEqual(limiter.take("1.1.1.1"), { ok: false, reason: "ip" });
  // Other visitors are unaffected.
  assert.equal(limiter.take("2.2.2.2").ok, true);
  // The window rolls over after an hour.
  at = 3_600_000;
  assert.equal(limiter.take("1.1.1.1").ok, true);
});

test("demo limiter enforces the global daily budget", () => {
  let at = 0;
  const limiter = createDemoLimiter({ turnsPerIpPerHour: 100, turnsPerDay: 3, now: () => at });

  assert.equal(limiter.take("1.1.1.1").ok, true);
  assert.equal(limiter.take("2.2.2.2").ok, true);
  assert.equal(limiter.take("3.3.3.3").ok, true);
  assert.deepEqual(limiter.take("4.4.4.4"), { ok: false, reason: "day" });
  at = 24 * 3_600_000;
  assert.equal(limiter.take("4.4.4.4").ok, true);
});

test("clientIp prefers the first x-forwarded-for hop", () => {
  assert.equal(
    clientIp({ headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, socket: {} }),
    "9.9.9.9",
  );
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
});
