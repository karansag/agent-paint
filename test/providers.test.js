import test from "node:test";
import assert from "node:assert/strict";

import {
  curateModelList,
  findRejectedSamplingParam,
  buildModelsEndpoint,
  normalizeModelList,
  normalizeProviderId,
  inferProviderFromBaseUrl,
  buildChatEndpoint,
  getProviderDefinition,
  getProviderApiKey,
  normalizeBaseUrl,
} from "../lib/providers.js";

test("normalizeProviderId maps aliases", () => {
  assert.equal(normalizeProviderId("claude"), "anthropic");
  assert.equal(normalizeProviderId("Anthropic"), "anthropic");
  assert.equal(normalizeProviderId("llama.cpp"), "llama");
  assert.equal(normalizeProviderId("gemma"), "llama");
  assert.equal(normalizeProviderId("openai"), "openai");
  assert.equal(normalizeProviderId("something-else"), "custom");
});

test("inferProviderFromBaseUrl recognizes hosts", () => {
  assert.equal(inferProviderFromBaseUrl("https://api.anthropic.com/v1"), "anthropic");
  assert.equal(inferProviderFromBaseUrl("https://api.openai.com/v1"), "openai");
  assert.equal(inferProviderFromBaseUrl("http://127.0.0.1:8081"), "llama");
  assert.equal(inferProviderFromBaseUrl("https://my-gateway.example.com"), "custom");
  assert.equal(inferProviderFromBaseUrl(""), "");
});

test("buildChatEndpoint deduplicates /v1", () => {
  assert.equal(
    buildChatEndpoint("https://api.openai.com/v1", "/v1/chat/completions"),
    "https://api.openai.com/v1/chat/completions",
  );
  assert.equal(
    buildChatEndpoint("http://127.0.0.1:8081", "/v1/chat/completions"),
    "http://127.0.0.1:8081/v1/chat/completions",
  );
  assert.equal(
    buildChatEndpoint("https://api.openai.com/v1", "/chat/completions"),
    "https://api.openai.com/v1/chat/completions",
  );
});

test("normalizeBaseUrl strips trailing slashes and query", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8081/", ""), "http://127.0.0.1:8081");
  assert.equal(normalizeBaseUrl("https://x.test/v1/?a=1#b", ""), "https://x.test/v1");
  assert.throws(() => normalizeBaseUrl("ftp://x.test", ""));
});

test("getProviderDefinition falls back to custom", () => {
  assert.equal(getProviderDefinition("nope").label, "Custom OpenAI-compatible");
  assert.equal(getProviderDefinition("anthropic").defaultModel, "claude-opus-4-8");
});

test("buildModelsEndpoint handles bases with and without /v1", () => {
  assert.equal(
    buildModelsEndpoint("https://api.openai.com/v1"),
    "https://api.openai.com/v1/models",
  );
  assert.equal(buildModelsEndpoint("http://127.0.0.1:8081"), "http://127.0.0.1:8081/v1/models");
});

test("normalizeModelList handles OpenAI, llama.cpp, and Anthropic shapes", () => {
  const openai = normalizeModelList(
    {
      data: [
        { id: "gpt-4.1-mini", created: 200 },
        { id: "gpt-4.1", created: 300 },
        { id: "text-embedding-3-small", created: 400 },
        { id: "whisper-1", created: 100 },
        { id: "gpt-4.1", created: 300 },
      ],
    },
    "openai",
  );
  assert.deepEqual(
    openai.map((m) => m.id),
    ["gpt-4.1", "gpt-4.1-mini"],
  );

  const llama = normalizeModelList(
    { models: [{ name: "gemma.gguf", model: "gemma.gguf" }] },
    "llama",
  );
  assert.deepEqual(llama, [{ id: "gemma.gguf", label: "gemma.gguf" }]);

  const anthropic = normalizeModelList(
    {
      data: [
        {
          id: "claude-haiku-4-5",
          display_name: "Claude Haiku 4.5",
          created_at: "2025-10-01T00:00:00Z",
        },
        {
          id: "claude-opus-4-8",
          display_name: "Claude Opus 4.8",
          created_at: "2026-03-01T00:00:00Z",
        },
      ],
    },
    "anthropic",
  );
  assert.equal(anthropic[0].id, "claude-opus-4-8");
  assert.equal(anthropic[0].label, "Claude Opus 4.8");
});

test("normalizeModelList tolerates junk payloads", () => {
  assert.deepEqual(normalizeModelList(null, "openai"), []);
  assert.deepEqual(normalizeModelList({ error: "nope" }, "llama"), []);
  assert.deepEqual(normalizeModelList({ data: [{}] }, "custom"), []);
});

test("curateModelList keeps one model per Claude family", () => {
  const list = [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  ];
  assert.deepEqual(
    curateModelList(list, "anthropic").map((m) => m.id),
    ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  );
});

test("curateModelList keeps newest gpt series plus minis", () => {
  const list = [
    { id: "gpt-5.5-pro" },
    { id: "gpt-5.5-pro-2026-04-23" },
    { id: "gpt-5.5" },
    { id: "gpt-5.5-2026-04-23" },
    { id: "gpt-5.4-mini" },
    { id: "gpt-5-mini" },
    { id: "gpt-4.1-mini" },
    { id: "gpt-4o-mini" },
    { id: "gpt-5.4" },
    { id: "chat-latest" },
    { id: "gpt-4.1" },
  ].map((m) => ({ ...m, label: m.id }));
  assert.deepEqual(
    curateModelList(list, "openai").map((m) => m.id),
    ["gpt-5.5-pro", "gpt-5.5", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini"],
  );
});

test("curateModelList passes other providers through", () => {
  const list = [{ id: "gemma.gguf", label: "gemma.gguf" }];
  assert.deepEqual(curateModelList(list, "llama"), list);
});

test("findRejectedSamplingParam identifies the param a 400 names", () => {
  const claudeError =
    'Claude returned 400: {"error":{"code":"invalid_request_error","message":"`top_p` is deprecated for this model.","type":"invalid_request_error","param":null}}';
  assert.equal(findRejectedSamplingParam(claudeError, { temperature: 0.7, top_p: 0.9 }), "top_p");
  assert.equal(
    findRejectedSamplingParam(
      "Claude returned 400: `temperature` is not supported for this model.",
      { temperature: 0.7 },
    ),
    "temperature",
  );
  // Param must actually be in the request body
  assert.equal(findRejectedSamplingParam(claudeError, { temperature: 0.7 }), null);
  // Unrelated errors don't trigger param stripping
  assert.equal(
    findRejectedSamplingParam("fetch failed | cause=ECONNREFUSED", { top_p: 0.9 }),
    null,
  );
});

test("getProviderApiKey reads provider env vars in order", () => {
  const env = { ANTHROPIC_API_KEY: "ant-key", LLM_API_KEY: "generic" };
  assert.equal(getProviderApiKey("anthropic", env), "ant-key");
  assert.equal(getProviderApiKey("llama", env), "generic");
  assert.equal(getProviderApiKey("openai", {}), "");
});
