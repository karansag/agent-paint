import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, "public");

const PORT = Number(process.env.PORT || 5173);
const PROVIDER_DEFINITIONS = {
  llama: {
    label: "Local llama.cpp",
    defaultBaseUrl: "http://127.0.0.1:8081",
    defaultChatPath: "/v1/chat/completions",
    defaultModel: "gemma-4-26B-A4B-it-Q4_K_M.gguf",
    tokenParam: "max_tokens",
    maxTemperature: 2,
    apiKeyEnv: ["LLAMA_API_KEY", "LLM_API_KEY", "OPENAI_API_KEY"],
    visionStrategy: "llama-props",
    sampling: "llama",
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
  },
  anthropic: {
    label: "Claude",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultChatPath: "/chat/completions",
    defaultModel: "claude-sonnet-4-6",
    tokenParam: "max_tokens",
    maxTemperature: 1,
    apiKeyEnv: ["ANTHROPIC_API_KEY", "LLM_API_KEY"],
    visionStrategy: "assume",
    sampling: "anthropic",
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
  },
};
const GENERIC_PROVIDER_ENV = process.env.LLM_PROVIDER || process.env.PROVIDER || "";
const GENERIC_BASE_URL_ENV =
  process.env.LLM_BASE_URL ||
  process.env.API_BASE_URL ||
  process.env.OPENAI_BASE_URL ||
  process.env.ANTHROPIC_BASE_URL ||
  process.env.LLAMA_SERVER_URL ||
  "";
const GENERIC_MODEL_ENV =
  process.env.LLM_MODEL ||
  process.env.MODEL ||
  process.env.OPENAI_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  process.env.LLAMA_MODEL ||
  "";
const GENERIC_CHAT_PATH_ENV =
  process.env.LLM_CHAT_PATH ||
  process.env.CHAT_COMPLETIONS_PATH ||
  process.env.OPENAI_CHAT_PATH ||
  process.env.ANTHROPIC_CHAT_PATH ||
  process.env.LLAMA_CHAT_PATH ||
  "";
const DEFAULT_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || process.env.LLAMA_MAX_TOKENS || 1400);
const STARTUP_PROVIDER_CONFIG = await resolveStartupProviderConfig();
const DEFAULT_PROVIDER = STARTUP_PROVIDER_CONFIG.provider;
const DEFAULT_API_BASE_URL = STARTUP_PROVIDER_CONFIG.apiBaseUrl;
const DEFAULT_CHAT_PATH = STARTUP_PROVIDER_CONFIG.chatPath;
const DEFAULT_MODEL = STARTUP_PROVIDER_CONFIG.model;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

const SYSTEM_PROMPT = `You are controlling an MS Paint style canvas.

Output format is strict:
- Emit exactly one JSON object at a time.
- Do not use markdown, comments, arrays, or prose outside JSON.
- The browser executes each valid object immediately as it streams in.
- Keep coordinates inside the canvas.
- Draw progressively in batches of 4 to 12 visible commands.
- End each batch with {"type":"batchEnd","continue":true,"note":"short next-step note"}.
- Use {"type":"batchEnd","continue":true,"note":"short next-step note"} when you want another turn.
- Use {"type":"batchEnd","continue":false,"note":"finished"} when you decide the drawing is complete or the user explicitly asks to stop.

Available commands:
{"type":"setColor","color":"#RRGGBB"}
{"type":"setBrush","size":1}
{"type":"stroke","points":[[x,y],[x,y],[x,y]]}
{"type":"path","d":[["M",x,y],["C",cx1,cy1,cx2,cy2,x,y],["Q",cx,cy,x,y],["L",x,y],["Z"]],"fill":false}
{"type":"line","x1":0,"y1":0,"x2":0,"y2":0}
{"type":"rect","x":0,"y":0,"w":0,"h":0,"fill":false}
{"type":"ellipse","x":0,"y":0,"rx":0,"ry":0,"fill":false}
{"type":"circle","x":0,"y":0,"r":0,"fill":false}
{"type":"fill","x":0,"y":0}
{"type":"text","x":0,"y":0,"text":"label","size":20}
{"type":"undo","count":1}
{"type":"batchEnd","continue":true,"note":"short note"}

Good drawing strategy:
- Start with large silhouette shapes, then add details.
- Prefer clear iconic subjects that read well at canvas scale.
- Use fill commands only inside closed regions.
- Use strokes for organic shapes and lines/rectangles/ellipses for geometry.
- Prefer path with Bezier segments for smooth curves: M moves, L draws a line, C is a cubic Bezier (two control points then the endpoint), Q is a quadratic Bezier (one control point then the endpoint), Z closes the shape. All coordinates are absolute. One path with curves reads better than many tiny straight strokes.
- Avoid tiny details until the main subject is recognizable.
- For edit requests, preserve the existing drawing. Do not redraw the whole scene, erase it, paint over it with white, or cover existing objects with large filled shapes unless the user explicitly asks.
- For blank new requests, choose what to draw yourself. There is no hidden target and no preferred theme.`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/config") {
      const visionSupported = await detectVisionSupport({
        provider: DEFAULT_PROVIDER,
        baseUrl: DEFAULT_API_BASE_URL,
      });
      sendJson(res, {
        provider: DEFAULT_PROVIDER,
        providers: buildProviderOptions(visionSupported),
        apiBaseUrl: DEFAULT_API_BASE_URL,
        chatPath: DEFAULT_CHAT_PATH,
        model: DEFAULT_MODEL,
        visionSupported,
        llamaServerUrl: DEFAULT_API_BASE_URL,
        llamaChatPath: DEFAULT_CHAT_PATH,
      });
      return;
    }

    const filePath = resolvePublicPath(req.url || "/");
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES.get(extname(filePath)) || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (error) {
    const status = error.code === "ENOENT" ? 404 : 500;
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(status === 404 ? "Not found" : "Server error");
  }
});

const wss = new WebSocketServer({ server, path: "/agent" });

wss.on("connection", async (ws) => {
  const session = {
    messages: [{ role: "system", content: SYSTEM_PROMPT }],
    running: false,
    abortController: null,
    width: 768,
    height: 512,
    commandCount: 0,
    turn: 0,
    lastAssistantText: "",
  };
  const defaultVisionSupported = await detectVisionSupport({
    provider: DEFAULT_PROVIDER,
    baseUrl: DEFAULT_API_BASE_URL,
  });

  send(ws, "hello", {
    provider: DEFAULT_PROVIDER,
    providers: buildProviderOptions(defaultVisionSupported),
    apiBaseUrl: DEFAULT_API_BASE_URL,
    chatPath: DEFAULT_CHAT_PATH,
    model: DEFAULT_MODEL,
    visionSupported: defaultVisionSupported,
    llamaServerUrl: DEFAULT_API_BASE_URL,
    llamaChatPath: DEFAULT_CHAT_PATH,
  });

  ws.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      send(ws, "error", { message: "Browser sent invalid JSON." });
      return;
    }

    if (payload.type === "stop") {
      stopSession(session);
      send(ws, "status", { message: "Stopped." });
      return;
    }

    if (payload.type === "start") {
      stopSession(session);
      resetConversation(session, payload);
      await runModelTurn(ws, session, payload);
      return;
    }

    if (payload.type === "feedback") {
      await runModelTurn(ws, session, payload);
      return;
    }

    send(ws, "error", { message: `Unsupported message type: ${String(payload.type)}` });
  });

  ws.on("close", () => stopSession(session));
});

server.listen(PORT, () => {
  console.log(`Agent Paint listening at http://localhost:${PORT}`);
  console.log(
    `Default provider: ${getProviderDefinition(DEFAULT_PROVIDER).label} at ${buildChatEndpoint(DEFAULT_API_BASE_URL, DEFAULT_CHAT_PATH)}`,
  );
});

function resolvePublicPath(url) {
  const parsed = new URL(url, "http://localhost");
  const requestedPath = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const normalized = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    throw Object.assign(new Error("Invalid path"), { code: "ENOENT" });
  }

  return filePath;
}

function sendJson(res, payload) {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function stopSession(session) {
  if (session.abortController) {
    session.abortController.abort();
  }
  session.abortController = null;
  session.running = false;
}

function resetConversation(session, payload) {
  session.messages = [{ role: "system", content: SYSTEM_PROMPT }];
  session.turn = 0;
  session.commandCount = 0;
  session.lastAssistantText = "";
  session.width = clampInt(payload.canvas?.width, 128, 2048, 768);
  session.height = clampInt(payload.canvas?.height, 128, 2048, 512);
}

async function runModelTurn(ws, session, payload) {
  if (session.running) {
    send(ws, "error", { message: "The model is already producing a drawing batch." });
    return;
  }

  session.running = true;
  session.abortController = new AbortController();
  session.turn += 1;

  let config;
  try {
    config = normalizeModelConfig(payload.config);
  } catch (error) {
    send(ws, "error", { message: formatModelError(error) });
    session.running = false;
    session.abortController = null;
    return;
  }

  session.width = clampInt(payload.canvas?.width, 128, 2048, session.width);
  session.height = clampInt(payload.canvas?.height, 128, 2048, session.height);
  const visionSupported = payload.useVision ? await detectVisionSupport(config) : false;
  const effectivePayload = {
    ...payload,
    useVision: Boolean(payload.useVision && visionSupported),
  };

  if (payload.useVision && !visionSupported) {
    send(ws, "modelWarning", {
      message: `${config.providerLabel} was asked to receive screenshots, but this endpoint does not currently report vision support.`,
    });
  }

  const userMessage = buildUserMessage(effectivePayload, session);
  const requestBody = buildChatCompletionRequest(config, [
    session.messages[0],
    userMessage,
  ]);
  const requestUsesVision = Boolean(
    effectivePayload.useVision &&
      (effectivePayload.canvas?.image || effectivePayload.reference?.image),
  );

  let assistantText = "";
  let commandsThisTurn = 0;
  let batchContinue = true;
  const startedAt = Date.now();

  send(ws, "modelStart", {
    turn: session.turn,
    provider: config.provider,
    providerLabel: config.providerLabel,
    endpoint: config.endpoint,
    usingVision: requestUsesVision,
    sampling: {
      temperature: config.temperature,
      topP: config.topP,
      topK: config.topK,
      minP: config.minP,
      seed: config.seed,
    },
  });

  const extractor = createJsonObjectExtractor((rawCommand) => {
    const command = sanitizeCommand(rawCommand, session.width, session.height);

    if (!command.ok) {
      send(ws, "modelWarning", {
        message: command.reason,
        raw: rawCommand,
      });
      return;
    }

    commandsThisTurn += isVisibleCommand(command.value) ? 1 : 0;
    session.commandCount += isVisibleCommand(command.value) ? 1 : 0;

    if (command.value.type === "batchEnd") {
      batchContinue = command.value.continue;
    }

    send(ws, "agentCommand", {
      command: command.value,
      turn: session.turn,
      commandIndex: session.commandCount,
    });
  });

  try {
    await fetchAndConsumeModelStream({
      config,
      requestBody,
      signal: session.abortController.signal,
      onContent(content) {
        assistantText += content;
        extractor.push(content);
        send(ws, "modelText", { text: content });
      },
    });

    extractor.flush();
    session.lastAssistantText = truncate(assistantText, 5000);

    send(ws, "modelDone", {
      turn: session.turn,
      commandsThisTurn,
      totalCommands: session.commandCount,
      continue: batchContinue,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      send(ws, "modelDone", {
        turn: session.turn,
        commandsThisTurn,
        totalCommands: session.commandCount,
        continue: false,
        aborted: true,
        elapsedMs: Date.now() - startedAt,
      });
    } else if (
      requestUsesVision &&
      commandsThisTurn === 0 &&
      assistantText.length === 0 &&
      shouldRetryWithoutVision(error)
    ) {
      send(ws, "modelWarning", {
        message: `Vision request failed before any tokens arrived: ${formatModelError(error)}. Retrying this turn without screenshots.`,
      });

      try {
        const fallbackPayload = stripImagesFromPayload(effectivePayload);
        requestBody.messages = [
          session.messages[0],
          buildUserMessage(fallbackPayload, session),
        ];

        await fetchAndConsumeModelStream({
          config,
          requestBody,
          signal: session.abortController.signal,
          onContent(content) {
            assistantText += content;
            extractor.push(content);
            send(ws, "modelText", { text: content });
          },
        });

        extractor.flush();
        session.lastAssistantText = truncate(assistantText, 5000);

        send(ws, "modelDone", {
          turn: session.turn,
          commandsThisTurn,
          totalCommands: session.commandCount,
          continue: batchContinue,
          retriedWithoutVision: true,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (fallbackError) {
        send(ws, "error", { message: formatModelError(fallbackError) });
        send(ws, "modelDone", {
          turn: session.turn,
          commandsThisTurn,
          totalCommands: session.commandCount,
          continue: false,
          elapsedMs: Date.now() - startedAt,
        });
      }
    } else {
      send(ws, "error", { message: formatModelError(error) });
      send(ws, "modelDone", {
        turn: session.turn,
        commandsThisTurn,
        totalCommands: session.commandCount,
        continue: false,
        elapsedMs: Date.now() - startedAt,
      });
    }
  } finally {
    session.running = false;
    session.abortController = null;
  }
}

async function fetchAndConsumeModelStream({ config, requestBody, signal, onContent }) {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `${config.providerLabel} returned ${response.status}: ${truncate(errorText || response.statusText, 1200)}`,
    );
  }

  if (!response.body) {
    throw new Error(`${config.providerLabel} response did not include a readable stream.`);
  }

  for await (const content of readOpenAIContentStream(response.body)) {
    onContent(content);
  }
}

function normalizeModelConfig(input = {}) {
  const rawBaseUrl = input.apiBaseUrl || input.llamaServerUrl || "";
  const provider = normalizeProviderId(
    input.provider || inferProviderFromBaseUrl(rawBaseUrl) || DEFAULT_PROVIDER,
  );
  const definition = getProviderDefinition(provider);
  const baseUrl = normalizeBaseUrl(rawBaseUrl || definition.defaultBaseUrl, definition.defaultBaseUrl);
  const chatPath = normalizePath(
    input.chatPath || input.llamaChatPath || definition.defaultChatPath,
    definition.defaultChatPath,
  );
  const fallbackTemperature = Math.min(0.65, definition.maxTemperature);

  return {
    provider,
    providerLabel: definition.label,
    tokenParam: definition.tokenParam,
    sampling: definition.sampling,
    baseUrl,
    chatPath,
    endpoint: buildChatEndpoint(baseUrl, chatPath),
    model: String(input.model || definition.defaultModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    apiKey: String(input.apiKey || getProviderApiKey(provider) || "").trim(),
    temperature: clampNumber(input.temperature, 0, definition.maxTemperature, fallbackTemperature),
    maxTokens: clampInt(input.maxTokens, 256, 8192, DEFAULT_MAX_TOKENS),
    seed: input.seed === undefined || input.seed === null ? null : clampInt(input.seed, 0, 4294967295, 0),
    topP: optionalNumber(input.topP, 0, 1),
    topK: optionalInt(input.topK, 0, 1000),
    minP: optionalNumber(input.minP, 0, 1),
    repeatPenalty: optionalNumber(input.repeatPenalty, 0.01, 4),
    presencePenalty: optionalNumber(input.presencePenalty, -2, 2),
    frequencyPenalty: optionalNumber(input.frequencyPenalty, -2, 2),
    xtcProbability: optionalNumber(input.xtcProbability, 0, 1),
    xtcThreshold: optionalNumber(input.xtcThreshold, 0, 1),
    dynatempRange: optionalNumber(input.dynatempRange, 0, 2),
    dynatempExponent: optionalNumber(input.dynatempExponent, 0.01, 10),
  };
}

function buildChatCompletionRequest(config, messages) {
  const requestBody = {
    model: config.model,
    messages,
    stream: true,
    temperature: config.temperature,
  };

  requestBody[config.tokenParam] = config.maxTokens;
  addSamplingParams(requestBody, config);
  return requestBody;
}

function addSamplingParams(requestBody, config) {
  const mappings =
    config.sampling === "llama"
      ? [
          ["seed", config.seed],
          ["top_p", config.topP],
          ["top_k", config.topK],
          ["min_p", config.minP],
          ["repeat_penalty", config.repeatPenalty],
          ["presence_penalty", config.presencePenalty],
          ["frequency_penalty", config.frequencyPenalty],
          ["xtc_probability", config.xtcProbability],
          ["xtc_threshold", config.xtcThreshold],
          ["dynatemp_range", config.dynatempRange],
          ["dynatemp_exponent", config.dynatempExponent],
        ]
      : config.sampling === "openai"
        ? [
            ["top_p", config.topP],
            ["presence_penalty", config.presencePenalty],
            ["frequency_penalty", config.frequencyPenalty],
          ]
        : [];

  for (const [key, value] of mappings) {
    if (value !== null) requestBody[key] = value;
  }
}

async function resolveStartupProviderConfig() {
  const provider = normalizeProviderId(
    GENERIC_PROVIDER_ENV || inferProviderFromBaseUrl(GENERIC_BASE_URL_ENV) || "llama",
  );
  const definition = getProviderDefinition(provider);
  const chatPath = normalizePath(GENERIC_CHAT_PATH_ENV || definition.defaultChatPath, definition.defaultChatPath);

  if (provider === "llama" && !GENERIC_BASE_URL_ENV) {
    for (const candidate of ["http://127.0.0.1:8081", "http://127.0.0.1:8080"]) {
      if (await isLlamaServerHealthy(candidate)) {
        return {
          provider,
          apiBaseUrl: candidate,
          chatPath,
          model: GENERIC_MODEL_ENV || (await detectModelName(candidate)) || definition.defaultModel,
        };
      }
    }
  }

  const apiBaseUrl = normalizeBaseUrl(
    GENERIC_BASE_URL_ENV || definition.defaultBaseUrl,
    definition.defaultBaseUrl,
  );
  return {
    provider,
    apiBaseUrl,
    chatPath,
    model: GENERIC_MODEL_ENV || (provider === "llama" ? await detectModelName(apiBaseUrl) : "") || definition.defaultModel,
  };
}

async function isLlamaServerHealthy(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(400),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function detectModelName(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return "";

    const payload = await response.json();
    return (
      payload.data?.[0]?.id ||
      payload.models?.[0]?.model ||
      payload.models?.[0]?.name ||
      ""
    );
  } catch {
    return "";
  }
}

async function detectVisionSupport(config) {
  const provider = normalizeProviderId(config?.provider || DEFAULT_PROVIDER);
  const definition = getProviderDefinition(provider);

  if (definition.visionStrategy === "assume") {
    return true;
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(config?.baseUrl || DEFAULT_API_BASE_URL)}/props`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return false;

    const payload = await response.json();
    return Boolean(payload.modalities?.vision);
  } catch {
    return false;
  }
}

function buildProviderOptions(defaultProviderVisionSupported = false) {
  return Object.entries(PROVIDER_DEFINITIONS).map(([id, definition]) => ({
    id,
    label: definition.label,
    apiBaseUrl: id === DEFAULT_PROVIDER ? DEFAULT_API_BASE_URL : definition.defaultBaseUrl,
    chatPath: id === DEFAULT_PROVIDER ? DEFAULT_CHAT_PATH : definition.defaultChatPath,
    model: id === DEFAULT_PROVIDER ? DEFAULT_MODEL : definition.defaultModel,
    needsApiKey: id !== "llama",
    visionDefault:
      id === DEFAULT_PROVIDER
        ? defaultProviderVisionSupported
        : definition.visionStrategy === "assume",
  }));
}

function getProviderDefinition(provider) {
  return PROVIDER_DEFINITIONS[provider] || PROVIDER_DEFINITIONS.custom;
}

function normalizeProviderId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["claude", "anthropic"].includes(normalized)) return "anthropic";
  if (["local", "llama", "llama.cpp", "llamacpp"].includes(normalized)) return "llama";
  if (normalized === "openai") return "openai";
  if (normalized === "custom") return "custom";
  return PROVIDER_DEFINITIONS[normalized] ? normalized : "custom";
}

function inferProviderFromBaseUrl(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (text.includes("anthropic.com") || text.includes("claude.com")) return "anthropic";
  if (text.includes("openai.com")) return "openai";
  if (text.includes("127.0.0.1") || text.includes("localhost")) return "llama";
  return "custom";
}

function getProviderApiKey(provider) {
  const definition = getProviderDefinition(provider);
  for (const name of definition.apiKeyEnv) {
    if (process.env[name]) return process.env[name];
  }
  return "";
}

function normalizeBaseUrl(value, fallback = DEFAULT_API_BASE_URL) {
  const url = new URL(String(value || fallback).trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("API base URL must start with http:// or https://.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizePath(value, fallback = DEFAULT_CHAT_PATH) {
  const path = String(value || fallback).trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function buildChatEndpoint(baseUrl, chatPath) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  let normalizedPath = normalizePath(chatPath);
  const basePath = new URL(normalizedBase).pathname.replace(/\/+$/, "");

  if (basePath.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    normalizedPath = normalizedPath.slice(3);
  }

  return `${normalizedBase}${normalizedPath}`;
}

function buildUserMessage(payload, session) {
  const prompt = truncate(String(payload.prompt || "").trim(), 800);
  const mode = ["new", "edit", "continue"].includes(payload.mode) ? payload.mode : "continue";
  const includeCanvasImage = Boolean(payload.useVision && payload.canvas?.image);
  const includeReferenceImage = Boolean(
    !includeCanvasImage && payload.useVision && payload.reference?.image,
  );
  const recentActions = Array.isArray(payload.recentActions)
    ? payload.recentActions.slice(-16)
    : [];
  const historyActions = Array.isArray(payload.historyActions)
    ? payload.historyActions.slice(-60)
    : [];
  const promptHistory = Array.isArray(payload.promptHistory)
    ? payload.promptHistory.slice(-8)
    : [];
  const stats = payload.canvas?.stats || {};
  const turnBudget = normalizeTurnBudget(payload.turnBudget);
  const modeInstruction =
    mode === "edit"
      ? "This is an edit to the existing drawing. Preserve all existing objects. Add only the requested new elements. If something should appear behind an existing object, draw it around the object or as visible edge lines instead of covering the object."
      : mode === "new"
        ? "This is a new drawing request. Establish the main subject clearly."
        : "Continue refining the existing drawing. Preserve what is already on the canvas.";
  const referenceImageNote = includeReferenceImage
    ? "A user reference image is attached. Use it for the requested drawing."
    : payload.useVision && payload.reference?.image
      ? "A user reference image exists, but it is not attached because the current canvas screenshot is the single image for this request."
      : "";
  const blankChoiceBrief = createBlankChoiceBrief({ prompt, mode, payload });
  const statsText = [
    `Canvas: ${session.width}x${session.height}.`,
    `Turn: ${session.turn}.`,
    `Turn limit: current=${turnBudget.currentTurn}, max=${turnBudget.maxTurns}, remaining_after_this_request=${turnBudget.remainingAfterThisRequest}, auto_loop=${turnBudget.autoLoop}.`,
    `Request mode: ${mode}.`,
    modeInstruction,
    createBudgetInstruction(turnBudget),
    prompt ? `User request: ${prompt}` : "User request: none. Choose freely and draw whatever you decide.",
    blankChoiceBrief,
    payload.type === "feedback"
      ? "You are seeing feedback after the browser executed your previous commands."
      : "Begin the drawing.",
    includeCanvasImage
      ? "A current canvas screenshot is attached. Use the screenshot as the source of truth for what is already drawn."
      : "",
    referenceImageNote,
    `Recent executed commands: ${truncate(JSON.stringify(recentActions), 1200)}.`,
    historyActions.length
      ? `Accumulated drawing command history, oldest to newest and truncated: ${truncate(JSON.stringify(historyActions), 3000)}.`
      : "",
    promptHistory.length
      ? `User prompt history for this drawing: ${truncate(JSON.stringify(promptHistory), 900)}.`
      : "",
    stats.summary ? `Canvas visual summary: ${truncate(stats.summary, 900)}.` : "",
    "Return the next batch now as JSON objects only.",
  ]
    .filter(Boolean)
    .join("\n");

  const images = [];
  if (includeCanvasImage) {
    images.push({
      type: "image_url",
      image_url: { url: payload.canvas.image },
    });
  } else if (includeReferenceImage) {
    images.push({
      type: "image_url",
      image_url: { url: payload.reference.image },
    });
  }

  if (images.length === 0) {
    return { role: "user", content: statsText };
  }

  return {
    role: "user",
    content: [{ type: "text", text: statsText }, ...images],
  };
}

function stripImagesFromPayload(payload) {
  return {
    ...payload,
    useVision: false,
    canvas: payload.canvas ? { ...payload.canvas, image: undefined } : payload.canvas,
    reference: payload.reference ? { ...payload.reference, image: undefined } : payload.reference,
  };
}

function shouldRetryWithoutVision(error) {
  const message = `${error?.message || ""} ${error?.cause?.message || ""}`.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("terminated") ||
    message.includes("socket") ||
    message.includes("connection") ||
    message.includes("image") ||
    message.includes("multimodal") ||
    message.includes("mmproj") ||
    message.includes("invalid url")
  );
}

function formatModelError(error) {
  const parts = [error?.message || String(error)];
  const cause = error?.cause;

  if (cause?.code) parts.push(`cause=${cause.code}`);
  if (cause?.message) parts.push(cause.message);
  if (cause?.syscall) parts.push(`syscall=${cause.syscall}`);
  if (cause?.address || cause?.port) {
    parts.push(`target=${[cause.address, cause.port].filter(Boolean).join(":")}`);
  }

  return parts.filter(Boolean).join(" | ");
}

function normalizeTurnBudget(input = {}) {
  return {
    currentTurn: clampInt(input.currentTurn, 0, 1000, 0),
    maxTurns: clampInt(input.maxTurns, 1, 1000, 1),
    remainingAfterThisRequest: clampInt(input.remainingAfterThisRequest, 0, 1000, 0),
    autoLoop: Boolean(input.autoLoop),
  };
}

function createBudgetInstruction(turnBudget) {
  if (!turnBudget.autoLoop || turnBudget.remainingAfterThisRequest <= 0) {
    return "This is the last allowed turn for now. Use the batch to add visible drawing commands, then set batchEnd continue to false.";
  }

  return [
    "The browser can ask for more passes after this one, up to the turn limit.",
    "If the drawing is complete, set batchEnd continue to false and the browser will stop.",
    "If you want another turn, set batchEnd continue to true.",
    "Each pass should materially advance the drawing with new shapes, details, refinements, or corrections.",
  ].join(" ");
}

function createBlankChoiceBrief({ prompt, mode, payload }) {
  if (prompt || mode !== "new") return "";

  return [
    "Blank prompt: make your own choice.",
    `Random nonce for this choice: ${cleanText(payload.choiceNonce, 80) || randomNonce()}.`,
    "Use the nonce only to break ties and avoid repeating the same default. Do not describe the nonce.",
    "Pick any drawable subject, scene, object, pattern, or abstraction you want, then draw it.",
  ]
    .join("\n");
}

async function* readOpenAIContentStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          const content = parseStreamPayload(data);
          if (content) yield content;
          continue;
        }

        if (trimmed.startsWith("{")) {
          const content = parseStreamPayload(trimmed);
          if (content) yield content;
        }
      }
    }

    const final = buffer.trim();
    if (final && final.startsWith("{")) {
      const content = parseStreamPayload(final);
      if (content) yield content;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseStreamPayload(data) {
  try {
    const parsed = JSON.parse(data);
    return (
      parsed.choices?.[0]?.delta?.content ??
      parsed.choices?.[0]?.text ??
      parsed.content ??
      parsed.response ??
      ""
    );
  } catch {
    return "";
  }
}

function createJsonObjectExtractor(onObject) {
  let buffer = "";
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;

  function reset() {
    buffer = "";
    collecting = false;
    depth = 0;
    inString = false;
    escaped = false;
  }

  return {
    push(text) {
      for (const char of text) {
        if (!collecting) {
          if (char === "{") {
            collecting = true;
            depth = 1;
            buffer = "{";
          }
          continue;
        }

        buffer += char;

        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === "\"") {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (char === "{") depth += 1;
        if (char === "}") depth -= 1;

        if (depth === 0) {
          try {
            onObject(JSON.parse(buffer));
          } catch {
            // Ignore malformed extracted objects. The prompt and validation handle recovery.
          }
          reset();
        }

        if (buffer.length > 20000) {
          reset();
        }
      }
    },
    flush() {
      reset();
    },
  };
}

function sanitizeCommand(raw, width, height) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "Command was not a JSON object." };
  }

  const type = String(raw.type || "").trim();

  if (type === "setColor") {
    const color = normalizeHexColor(raw.color);
    if (!color) return { ok: false, reason: "setColor requires #RRGGBB." };
    return { ok: true, value: { type, color } };
  }

  if (type === "setBrush") {
    return { ok: true, value: { type, size: clampInt(raw.size, 1, 60, 4) } };
  }

  if (type === "stroke") {
    if (!Array.isArray(raw.points) || raw.points.length < 2) {
      return { ok: false, reason: "stroke requires at least two points." };
    }
    const points = raw.points
      .slice(0, 160)
      .map((point) => [
        clampNumber(point?.[0], 0, width, 0),
        clampNumber(point?.[1], 0, height, 0),
      ]);
    return { ok: true, value: { type, points } };
  }

  if (type === "path") {
    const d = sanitizePathSegments(raw.d, width, height);
    if (!d) {
      return { ok: false, reason: "path requires a 'd' array of segments starting with M, e.g. [[\"M\",x,y],[\"C\",...]]." };
    }
    return { ok: true, value: { type, d, fill: Boolean(raw.fill) } };
  }

  if (type === "line") {
    return {
      ok: true,
      value: {
        type,
        x1: clampNumber(raw.x1, 0, width, 0),
        y1: clampNumber(raw.y1, 0, height, 0),
        x2: clampNumber(raw.x2, 0, width, 0),
        y2: clampNumber(raw.y2, 0, height, 0),
      },
    };
  }

  if (type === "rect") {
    const rect = normalizeRect(raw.x, raw.y, raw.w, raw.h, width, height);
    return { ok: true, value: { type, ...rect, fill: Boolean(raw.fill) } };
  }

  if (type === "ellipse") {
    return {
      ok: true,
      value: {
        type,
        x: clampNumber(raw.x, 0, width, width / 2),
        y: clampNumber(raw.y, 0, height, height / 2),
        rx: clampNumber(raw.rx, 1, width / 2, 20),
        ry: clampNumber(raw.ry, 1, height / 2, 20),
        fill: Boolean(raw.fill),
      },
    };
  }

  if (type === "circle") {
    return {
      ok: true,
      value: {
        type,
        x: clampNumber(raw.x, 0, width, width / 2),
        y: clampNumber(raw.y, 0, height, height / 2),
        r: clampNumber(raw.r, 1, Math.min(width, height) / 2, 20),
        fill: Boolean(raw.fill),
      },
    };
  }

  if (type === "fill") {
    return {
      ok: true,
      value: {
        type,
        x: clampInt(raw.x, 0, width - 1, 0),
        y: clampInt(raw.y, 0, height - 1, 0),
      },
    };
  }

  if (type === "text") {
    return {
      ok: true,
      value: {
        type,
        x: clampNumber(raw.x, 0, width, 0),
        y: clampNumber(raw.y, 0, height, 0),
        text: truncate(String(raw.text || "").replace(/[\u0000-\u001f\u007f]/g, ""), 80),
        size: clampInt(raw.size, 8, 96, 22),
      },
    };
  }

  if (type === "undo") {
    return { ok: true, value: { type, count: clampInt(raw.count, 1, 8, 1) } };
  }

  if (type === "batchEnd") {
    return {
      ok: true,
      value: {
        type,
        continue: Boolean(raw.continue),
        note: truncate(String(raw.note || ""), 160),
      },
    };
  }

  return { ok: false, reason: `Unknown command type: ${type || "(missing)"}.` };
}

function isVisibleCommand(command) {
  return !["batchEnd", "setColor", "setBrush"].includes(command.type);
}

const PATH_SEGMENT_ARITY = { M: 2, L: 2, C: 6, Q: 4, Z: 0 };

function sanitizePathSegments(raw, width, height) {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const segments = [];
  for (const segment of raw.slice(0, 200)) {
    if (!Array.isArray(segment) || segment.length === 0) continue;
    const command = String(segment[0] || "").trim().toUpperCase();
    const arity = PATH_SEGMENT_ARITY[command];
    if (arity === undefined) continue;

    const coords = segment.slice(1, 1 + arity);
    if (coords.length < arity) continue;

    const clamped = coords.map((value, index) =>
      clampNumber(value, 0, index % 2 === 0 ? width : height, 0),
    );
    segments.push([command, ...clamped]);
  }

  if (segments.length < 2 || segments[0][0] !== "M") return null;
  if (!segments.some((segment) => ["L", "C", "Q"].includes(segment[0]))) return null;
  return segments;
}

function normalizeRect(x, y, w, h, width, height) {
  let left = clampNumber(x, -width, width, 0);
  let top = clampNumber(y, -height, height, 0);
  let rectWidth = clampNumber(w, -width, width, 10);
  let rectHeight = clampNumber(h, -height, height, 10);

  if (rectWidth < 0) {
    left += rectWidth;
    rectWidth = Math.abs(rectWidth);
  }
  if (rectHeight < 0) {
    top += rectHeight;
    rectHeight = Math.abs(rectHeight);
  }

  left = clampNumber(left, 0, width, 0);
  top = clampNumber(top, 0, height, 0);
  rectWidth = clampNumber(rectWidth, 1, width - left, 1);
  rectHeight = clampNumber(rectHeight, 1, height - top, 1);

  return { x: left, y: top, w: rectWidth, h: rectHeight };
}

function normalizeHexColor(value) {
  const color = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
  }
  return null;
}

function cleanText(value, maxLength) {
  return truncate(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim(), maxLength);
}

function randomNonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function optionalNumber(value, min, max) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function optionalInt(value, min, max) {
  const number = optionalNumber(value, min, max);
  return number === null ? null : Math.round(number);
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
