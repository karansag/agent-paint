// Provider presets for OpenAI-compatible streaming chat endpoints.
// Everything speaks POST {baseUrl}{chatPath} with `stream: true`; the
// differences are auth env vars, token param naming, sampling support,
// and how vision capability is detected.
export const PROVIDER_DEFINITIONS = {
  llama: {
    label: "Local llama.cpp",
    defaultBaseUrl: "http://127.0.0.1:8081",
    defaultChatPath: "/v1/chat/completions",
    defaultModel: "gemma-4-26B-A4B-it-Q4_K_M.gguf",
    tokenParam: "max_tokens",
    maxTemperature: 2,
    apiKeyEnv: ["LLAMA_API_KEY", "LLM_API_KEY"],
    visionStrategy: "llama-props",
    sampling: "llama",
    needsApiKey: false,
  },
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultChatPath: "/chat/completions",
    defaultModel: "gpt-4.1-mini",
    tokenParam: "max_completion_tokens",
    maxTemperature: 2,
    apiKeyEnv: ["OPENAI_API_KEY", "LLM_API_KEY"],
    visionStrategy: "assume",
    sampling: "openai",
    needsApiKey: true,
  },
  anthropic: {
    label: "Claude",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultChatPath: "/chat/completions",
    defaultModel: "claude-opus-4-8",
    tokenParam: "max_tokens",
    maxTemperature: 1,
    apiKeyEnv: ["ANTHROPIC_API_KEY", "LLM_API_KEY"],
    visionStrategy: "assume",
    sampling: "anthropic",
    needsApiKey: true,
  },
  custom: {
    label: "Custom OpenAI-compatible",
    defaultBaseUrl: "http://127.0.0.1:8081",
    defaultChatPath: "/v1/chat/completions",
    defaultModel: "",
    tokenParam: "max_tokens",
    maxTemperature: 2,
    apiKeyEnv: ["LLM_API_KEY", "OPENAI_API_KEY"],
    visionStrategy: "assume",
    sampling: "openai",
    needsApiKey: false,
  },
};

export function getProviderDefinition(provider) {
  return PROVIDER_DEFINITIONS[provider] || PROVIDER_DEFINITIONS.custom;
}

export function normalizeProviderId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["claude", "anthropic"].includes(normalized)) return "anthropic";
  if (["local", "llama", "llama.cpp", "llamacpp", "gemma"].includes(normalized)) return "llama";
  return PROVIDER_DEFINITIONS[normalized] ? normalized : "custom";
}

export function inferProviderFromBaseUrl(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (text.includes("anthropic.com") || text.includes("claude.com")) return "anthropic";
  if (text.includes("openai.com")) return "openai";
  if (text.includes("127.0.0.1") || text.includes("localhost")) return "llama";
  return "custom";
}

export function getProviderApiKey(provider, env = process.env) {
  for (const name of getProviderDefinition(provider).apiKeyEnv) {
    if (env[name]) return env[name];
  }
  return "";
}

export function normalizeBaseUrl(value, fallback) {
  const url = new URL(String(value || fallback).trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("API base URL must start with http:// or https://.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizePath(value, fallback) {
  const path = String(value || fallback).trim();
  return path.startsWith("/") ? path : `/${path}`;
}

const SAMPLING_PARAMS = ["temperature", "top_p", "top_k", "min_p", "seed"];

// Some models reject sampling params outright (e.g. Claude Opus 4.7+ 400s on
// temperature/top_p). Given a provider 400 message, return the first param in
// the request body it complains about, so the bridge can drop it and retry.
export function findRejectedSamplingParam(errorMessage, requestBody) {
  const message = String(errorMessage || "");
  if (!/invalid_request_error|unsupported|deprecated|not supported|400/i.test(message)) {
    return null;
  }
  for (const param of SAMPLING_PARAMS) {
    if (param in requestBody && new RegExp(`[\\s\`'"(]${param}[\\s\`'")]`).test(message)) {
      return param;
    }
  }
  return null;
}

export function buildModelsEndpoint(baseUrl) {
  const normalizedBase = normalizeBaseUrl(baseUrl, baseUrl);
  const basePath = new URL(normalizedBase).pathname.replace(/\/+$/, "");
  return basePath.endsWith("/v1") ? `${normalizedBase}/models` : `${normalizedBase}/v1/models`;
}

const OPENAI_NON_CHAT =
  /embed|whisper|tts|dall-e|audio|realtime|moderation|babbage|davinci|image|transcribe|computer-use/i;

// Accepts OpenAI-style ({data: [{id, created}]}), llama.cpp-style
// ({models: [{name|model}]}), and Anthropic-style ({data: [{id, display_name,
// created_at}]}) listings; returns [{id, label}] newest-first, deduped.
export function normalizeModelList(payload, provider) {
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];

  let models = entries
    .map((entry) => ({
      id: String(entry.id || entry.model || entry.name || "").trim(),
      label: String(entry.display_name || entry.id || entry.model || entry.name || "").trim(),
      created: toEpochMs(entry.created_at ?? entry.created),
    }))
    .filter((model) => model.id);

  if (provider === "openai") {
    models = models.filter((model) => !OPENAI_NON_CHAT.test(model.id));
  }

  models.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));

  const seen = new Set();
  return models
    .filter((model) => (seen.has(model.id) ? false : seen.add(model.id)))
    .map(({ id, label }) => ({ id, label }));
}

// Trim a full provider listing down to the majors. Input is newest-first
// (from normalizeModelList). Anthropic: newest model per family. OpenAI: the
// newest gpt-X series (regular + pro) plus the three newest minis/nanos,
// preferring undated aliases over dated snapshots. Falls back to the full
// list rather than returning nothing.
export function curateModelList(models, provider) {
  if (provider === "anthropic") {
    const picked = ["fable", "opus", "sonnet", "haiku"]
      .map((family) => models.find((model) => model.id.includes(family)))
      .filter(Boolean);
    return picked.length ? picked : models;
  }

  if (provider === "openai") {
    const ids = new Set(models.map((model) => model.id));
    const undated = models.filter((model) => {
      const alias = model.id.replace(/-\d{4}-\d{2}-\d{2}$/, "");
      return alias === model.id || !ids.has(alias);
    });

    const series = undated.filter((model) => /^gpt-[\d.]+(-pro)?$/.test(model.id));
    const newestVersion = Math.max(
      ...series.map((model) => Number.parseFloat(model.id.replace(/^gpt-/, ""))),
      0,
    );
    const main = series.filter(
      (model) => Number.parseFloat(model.id.replace(/^gpt-/, "")) === newestVersion,
    );
    const minis = undated.filter((model) => /^gpt-[\d.]+-(mini|nano)$/.test(model.id)).slice(0, 3);

    const picked = [...main, ...minis];
    return picked.length ? picked : models;
  }

  return models;
}

function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildChatEndpoint(baseUrl, chatPath) {
  const normalizedBase = normalizeBaseUrl(baseUrl, baseUrl);
  let normalizedPath = normalizePath(chatPath, chatPath);
  const basePath = new URL(normalizedBase).pathname.replace(/\/+$/, "");

  if (basePath.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    normalizedPath = normalizedPath.slice(3);
  }

  return `${normalizedBase}${normalizedPath}`;
}
