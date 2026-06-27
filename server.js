import http from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import {
  PROVIDER_DEFINITIONS,
  getProviderDefinition,
  normalizeProviderId,
  inferProviderFromBaseUrl,
  normalizeBaseUrl,
  buildChatEndpoint,
  buildModelsEndpoint,
  normalizeModelList,
  curateModelList,
  findRejectedSamplingParam,
  getProviderApiKey,
} from "./lib/providers.js";
import {
  createSvgElementExtractor,
  parseBatchElement,
  screenSvgElement,
} from "./lib/svg-stream.js";
import { clampNumber, clampInt, optionalNumber, optionalInt, truncate } from "./lib/util.js";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, "public");
const GALLERY_DIR = join(PUBLIC_DIR, "gallery");

const PORT = Number(process.env.PORT || 5173);
const ENV_PROVIDER = process.env.LLM_PROVIDER || "";
const ENV_BASE_URL = process.env.LLM_BASE_URL || "";
const ENV_MODEL = process.env.LLM_MODEL || "";
const DEFAULT_MAX_TOKENS = clampInt(process.env.LLM_MAX_TOKENS, 256, 16384, 2000);

const STARTUP = await resolveStartupConfig();

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);
const GALLERY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/config") {
      sendJson(res, await buildClientConfig());
      return;
    }

    if (req.url === "/api/gallery") {
      sendJson(res, await listGalleryImages());
      return;
    }

    if (req.url === "/api/random-prompt" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      sendJson(res, await generateRandomPrompt(JSON.parse(body || "{}")));
      return;
    }

    if (req.url === "/api/models" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      sendJson(res, await listProviderModels(JSON.parse(body || "{}")));
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
    running: false,
    abortController: null,
    width: 768,
    height: 512,
    elementCount: 0,
    turn: 0,
  };

  send(ws, "hello", await buildClientConfig());

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
      session.turn = 0;
      session.elementCount = 0;
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
    `Default provider: ${getProviderDefinition(STARTUP.provider).label} at ${buildChatEndpoint(STARTUP.apiBaseUrl, getProviderDefinition(STARTUP.provider).defaultChatPath)}`,
  );
});

async function buildClientConfig() {
  const visionSupported = await detectVisionSupport({
    provider: STARTUP.provider,
    baseUrl: STARTUP.apiBaseUrl,
  });
  return {
    provider: STARTUP.provider,
    apiBaseUrl: STARTUP.apiBaseUrl,
    model: STARTUP.model,
    visionSupported,
    providers: Object.entries(PROVIDER_DEFINITIONS).map(([id, definition]) => ({
      id,
      label: definition.label,
      apiBaseUrl: id === STARTUP.provider ? STARTUP.apiBaseUrl : definition.defaultBaseUrl,
      model: id === STARTUP.provider ? STARTUP.model : definition.defaultModel,
      needsApiKey: definition.needsApiKey,
      visionDefault:
        id === STARTUP.provider ? visionSupported : definition.visionStrategy === "assume",
    })),
  };
}

async function listProviderModels(input) {
  const provider = normalizeProviderId(
    input.provider || inferProviderFromBaseUrl(input.apiBaseUrl) || STARTUP.provider,
  );
  const definition = getProviderDefinition(provider);

  try {
    const baseUrl = normalizeBaseUrl(
      input.apiBaseUrl || definition.defaultBaseUrl,
      definition.defaultBaseUrl,
    );
    const apiKey = String(input.apiKey || getProviderApiKey(provider) || "").trim();
    const url = buildModelsEndpoint(baseUrl) + (provider === "anthropic" ? "?limit=100" : "");
    const headers =
      provider === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : apiKey
          ? { Authorization: `Bearer ${apiKey}` }
          : {};

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
    if (!response.ok) {
      const errorText = await response.text();
      return {
        provider,
        models: [],
        error: `${definition.label} model list returned ${response.status}: ${truncate(errorText || response.statusText, 300)}`,
      };
    }

    return {
      provider,
      models: curateModelList(normalizeModelList(await response.json(), provider), provider),
    };
  } catch (error) {
    return { provider, models: [], error: formatModelError(error) };
  }
}

function resolvePublicPath(url) {
  const parsed = new URL(url, "http://localhost");
  const requestedPath =
    parsed.pathname === "/"
      ? "/index.html"
      : parsed.pathname === "/gallery" || parsed.pathname === "/gallery/"
        ? "/gallery.html"
        : parsed.pathname;
  const normalized = normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    throw Object.assign(new Error("Invalid path"), { code: "ENOENT" });
  }

  return filePath;
}

async function listGalleryImages() {
  try {
    const entries = await readdir(GALLERY_DIR, { withFileTypes: true });
    const imageNames = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => GALLERY_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort((a, b) => b.localeCompare(a));
    const images = await Promise.all(
      imageNames.map(async (name) => ({
        name,
        url: `/gallery/${encodeURIComponent(name)}`,
        metadata: await readGalleryMetadata(name),
      })),
    );

    return { images };
  } catch (error) {
    if (error.code === "ENOENT") return { images: [] };
    throw error;
  }
}

async function readGalleryMetadata(imageName) {
  const sidecar = imageName.slice(0, -extname(imageName).length) + ".json";
  try {
    const parsed = JSON.parse(await readFile(join(GALLERY_DIR, sidecar), "utf8"));
    return {
      prompt: cleanText(parsed.prompt, 700),
      author: cleanText(parsed.author, 120),
      provider: cleanText(parsed.provider, 120),
      model: cleanText(parsed.model, 160),
      turns:
        parsed.turns === undefined || parsed.turns === null
          ? null
          : clampInt(parsed.turns, 0, 1000, 0),
      createdAt: cleanText(parsed.createdAt, 120),
    };
  } catch {
    return {};
  }
}

async function generateRandomPrompt(input) {
  try {
    const config = {
      ...normalizeModelConfig(input.config),
      maxTokens: 180,
    };
    const requestBody = buildChatCompletionRequest(config, [
      {
        role: "system",
        content:
          "Generate prompts for an autonomous canvas drawing agent. Return exactly one vivid drawing prompt, no markdown, no numbering, no explanation.",
      },
      {
        role: "user",
        content:
          "Create one fairly random, visually specific prompt for a 768x512 canvas. Prefer an unusual subject, setting, composition, or visual constraint. Keep it to one sentence.",
      },
    ]);
    let text = "";

    await fetchAndConsumeModelStream({
      config,
      requestBody,
      signal: AbortSignal.timeout(20000),
      onContent: (content) => {
        text += content;
      },
    });

    return { prompt: cleanGeneratedPrompt(text) };
  } catch (error) {
    return { error: formatModelError(error) };
  }
}

function cleanGeneratedPrompt(text) {
  return (
    cleanText(text, 400)
      .replace(/^[-*\d.\s"'`]*(prompt\s*:\s*)?/i, "")
      .replace(/["'`]+$/g, "")
      .trim() || "Draw a strange, detailed scene with a clear focal point."
  );
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

function buildSystemPrompt(config, session) {
  const { width, height } = session;
  return `You are ${config.model || "an AI model"}, painting live on a shared ${width}x${height} canvas.

You draw by streaming SVG markup. Protocol:
- Emit SVG elements only. No markdown, no code fences, no prose, no JSON.
- Each complete top-level element is painted onto the canvas the moment its closing tag arrives, in order, on top of whatever is already there.
- Allowed elements: path, rect, circle, ellipse, line, polyline, polygon, text, tspan, g, defs, use, symbol, linearGradient, radialGradient, stop.
- Use the full power of SVG: cubic and quadratic Bezier paths, gradients, opacity, transform, stroke-width, stroke-linecap, dash arrays. Group related shapes with <g>. Define gradients inside <defs> before referencing them with url(#id).
- All coordinates live in the ${width}x${height} viewBox. Keep shapes inside it.
- The canvas is raster: a painted element can never be moved or deleted, only painted over.
- After roughly 6 to 20 elements, end the batch with <batch continue="true" note="what comes next"/> to take another turn, or <batch continue="false" note="why it is finished"/> when the piece is done or the user asked to stop.

This canvas is yours. Draw in your own voice: your sense of composition, palette, and subject is the point of this exercise. Work from large background and silhouette shapes toward detail, but beyond that, trust your taste. Avoid generic clip art; make something only you would make. You may sign the work discreetly when it is finished.

When the request is an edit, preserve what is already on the canvas and integrate your additions with it instead of covering it. When the canvas is blank and the user gave no prompt, choose your subject freely.`;
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

  const requestBody = buildChatCompletionRequest(config, [
    { role: "system", content: buildSystemPrompt(config, session) },
    buildUserMessage(effectivePayload, session),
  ]);
  const requestUsesVision = Boolean(
    effectivePayload.useVision &&
    (effectivePayload.canvas?.image || effectivePayload.reference?.image),
  );

  let elementsThisTurn = 0;
  let batchContinue = true;
  const startedAt = Date.now();

  send(ws, "modelStart", {
    turn: session.turn,
    provider: config.provider,
    providerLabel: config.providerLabel,
    endpoint: config.endpoint,
    model: config.model,
    usingVision: requestUsesVision,
    sampling: {
      temperature: config.temperature,
      topP: config.topP,
      topK: config.topK,
      minP: config.minP,
      seed: config.seed,
    },
  });

  const extractor = createSvgElementExtractor((markup) => {
    const batch = parseBatchElement(markup);
    if (batch) {
      batchContinue = batch.continue;
      send(ws, "batch", { continue: batch.continue, note: batch.note, turn: session.turn });
      return;
    }

    const screened = screenSvgElement(markup);
    if (!screened.ok) {
      send(ws, "modelWarning", { message: screened.reason, raw: truncate(markup, 400) });
      return;
    }

    elementsThisTurn += 1;
    session.elementCount += 1;
    send(ws, "element", {
      markup: screened.markup,
      turn: session.turn,
      index: session.elementCount,
    });
  });

  // Some models 400 on sampling params (e.g. Claude Opus 4.7+ rejects
  // temperature/top_p). Drop the named param, retry, and remember the
  // rejection for this endpoint+model so future turns never resend it.
  // Provider 5xx hiccups get one retry before surfacing.
  let serverErrorRetries = 0;
  const consumeStream = async () => {
    while (true) {
      try {
        await fetchAndConsumeModelStream({
          config,
          requestBody,
          signal: session.abortController.signal,
          onContent: (content) => extractor.push(content),
        });
        return;
      } catch (error) {
        if (elementsThisTurn > 0) throw error;

        const param = findRejectedSamplingParam(error.message, requestBody);
        if (param) {
          delete requestBody[param];
          rejectedParamSet(config).add(param);
          send(ws, "modelWarning", {
            message: `${config.model} rejected '${param}'. Retrying without it; it will be skipped for this model from now on.`,
          });
          continue;
        }

        if (serverErrorRetries < 1 && /returned 5\d\d|server_error/i.test(error.message || "")) {
          serverErrorRetries += 1;
          send(ws, "modelWarning", {
            message: `${config.providerLabel} hit a transient server error. Retrying once.`,
          });
          await new Promise((resolve) => setTimeout(resolve, 750));
          continue;
        }

        throw error;
      }
    }
  };

  const sendDone = (extra = {}) =>
    send(ws, "modelDone", {
      turn: session.turn,
      elementsThisTurn,
      totalElements: session.elementCount,
      continue: batchContinue,
      elapsedMs: Date.now() - startedAt,
      ...extra,
    });

  try {
    await consumeStream();
    extractor.flush();
    sendDone();
  } catch (error) {
    if (error.name === "AbortError") {
      sendDone({ continue: false, aborted: true });
    } else if (requestUsesVision && elementsThisTurn === 0 && shouldRetryWithoutVision(error)) {
      send(ws, "modelWarning", {
        message: `Vision request failed before any drawing arrived: ${formatModelError(error)}. Retrying this turn without screenshots.`,
      });

      try {
        requestBody.messages[1] = buildUserMessage(stripImages(effectivePayload), session);
        await consumeStream();
        extractor.flush();
        sendDone({ retriedWithoutVision: true });
      } catch (fallbackError) {
        send(ws, "error", { message: formatModelError(fallbackError) });
        sendDone({ continue: false });
      }
    } else {
      send(ws, "error", { message: formatModelError(error) });
      sendDone({ continue: false });
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
  const rawBaseUrl = input.apiBaseUrl || "";
  const provider = normalizeProviderId(
    input.provider || inferProviderFromBaseUrl(rawBaseUrl) || STARTUP.provider,
  );
  const definition = getProviderDefinition(provider);
  const baseUrl = normalizeBaseUrl(
    rawBaseUrl || definition.defaultBaseUrl,
    definition.defaultBaseUrl,
  );
  return {
    provider,
    providerLabel: definition.label,
    tokenParam: definition.tokenParam,
    sampling: definition.sampling,
    baseUrl,
    endpoint: buildChatEndpoint(baseUrl, definition.defaultChatPath),
    model: String(input.model || definition.defaultModel || STARTUP.model).trim() || STARTUP.model,
    apiKey: String(input.apiKey || getProviderApiKey(provider) || "").trim(),
    temperature: clampNumber(
      input.temperature,
      0,
      definition.maxTemperature,
      Math.min(0.65, definition.maxTemperature),
    ),
    maxTokens: clampInt(input.maxTokens, 256, 16384, DEFAULT_MAX_TOKENS),
    seed:
      input.seed === undefined || input.seed === null
        ? null
        : clampInt(input.seed, 0, 4294967295, 0),
    topP: optionalNumber(input.topP, 0, 1),
    topK: optionalInt(input.topK, 0, 1000),
    minP: optionalNumber(input.minP, 0, 1),
  };
}

// Params each endpoint+model has 400ed on, so they are never resent.
const rejectedSamplingParams = new Map();

function rejectedParamSet(config) {
  const key = `${config.endpoint}|${config.model}`;
  if (!rejectedSamplingParams.has(key)) rejectedSamplingParams.set(key, new Set());
  return rejectedSamplingParams.get(key);
}

function buildChatCompletionRequest(config, messages) {
  const requestBody = {
    model: config.model,
    messages,
    stream: true,
  };
  requestBody[config.tokenParam] = config.maxTokens;

  // Only llama.cpp gets sampling params. Hosted models increasingly reject
  // them (Claude Opus 4.7+, OpenAI reasoning models), and the rejected-param
  // retry below catches any stragglers.
  const samplingParams = {
    llama: [
      ["temperature", config.temperature],
      ["seed", config.seed],
      ["top_p", config.topP],
      ["top_k", config.topK],
      ["min_p", config.minP],
    ],
    openai: [["seed", config.seed]],
    anthropic: [],
  };

  const rejected = rejectedParamSet(config);
  for (const [key, value] of samplingParams[config.sampling] || []) {
    if (value !== null && !rejected.has(key)) requestBody[key] = value;
  }

  return requestBody;
}

async function resolveStartupConfig() {
  const provider = normalizeProviderId(
    ENV_PROVIDER || inferProviderFromBaseUrl(ENV_BASE_URL) || "openai",
  );
  const definition = getProviderDefinition(provider);

  if (provider === "llama" && !ENV_BASE_URL) {
    for (const candidate of ["http://127.0.0.1:8081", "http://127.0.0.1:8080"]) {
      if (await isLlamaServerHealthy(candidate)) {
        return {
          provider,
          apiBaseUrl: candidate,
          model: ENV_MODEL || (await detectModelName(candidate)) || definition.defaultModel,
        };
      }
    }
  }

  const apiBaseUrl = normalizeBaseUrl(
    ENV_BASE_URL || definition.defaultBaseUrl,
    definition.defaultBaseUrl,
  );
  return {
    provider,
    apiBaseUrl,
    model:
      ENV_MODEL ||
      (provider === "llama" ? await detectModelName(apiBaseUrl) : "") ||
      definition.defaultModel,
  };
}

async function isLlamaServerHealthy(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(400) });
    return response.ok;
  } catch {
    return false;
  }
}

async function detectModelName(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return "";

    const payload = await response.json();
    return payload.data?.[0]?.id || payload.models?.[0]?.model || payload.models?.[0]?.name || "";
  } catch {
    return "";
  }
}

async function detectVisionSupport(config) {
  const provider = normalizeProviderId(config?.provider || STARTUP.provider);
  if (getProviderDefinition(provider).visionStrategy === "assume") {
    return true;
  }

  try {
    const baseUrl = normalizeBaseUrl(config?.baseUrl || STARTUP.apiBaseUrl, STARTUP.apiBaseUrl);
    const response = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return false;

    const payload = await response.json();
    return Boolean(payload.modalities?.vision);
  } catch {
    return false;
  }
}

function buildUserMessage(payload, session) {
  const prompt = truncate(String(payload.prompt || "").trim(), 800);
  const mode = ["new", "edit", "continue"].includes(payload.mode) ? payload.mode : "continue";
  const includeCanvasImage = Boolean(payload.useVision && payload.canvas?.image);
  const includeReferenceImage = Boolean(
    !includeCanvasImage && payload.useVision && payload.reference?.image,
  );
  const recentElements = Array.isArray(payload.recentElements)
    ? payload.recentElements.slice(-16)
    : [];
  const elementHistory = Array.isArray(payload.elementHistory)
    ? payload.elementHistory.slice(-60)
    : [];
  const promptHistory = Array.isArray(payload.promptHistory) ? payload.promptHistory.slice(-8) : [];
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

  const text = [
    `Canvas: ${session.width}x${session.height}.`,
    `Turn: ${session.turn}.`,
    `Turn limit: current=${turnBudget.currentTurn}, max=${turnBudget.maxTurns}, remaining_after_this_request=${turnBudget.remainingAfterThisRequest}, auto_loop=${turnBudget.autoLoop}.`,
    `Request mode: ${mode}.`,
    modeInstruction,
    createBudgetInstruction(turnBudget),
    prompt
      ? `User request: ${prompt}`
      : "User request: none. Choose freely and draw whatever you decide.",
    createBlankChoiceBrief({ prompt, mode, payload }),
    payload.type === "feedback"
      ? "You are seeing feedback after the browser painted your previous elements."
      : "Begin the drawing.",
    includeCanvasImage
      ? "A current canvas screenshot is attached. Use the screenshot as the source of truth for what is already drawn."
      : "",
    referenceImageNote,
    recentElements.length
      ? `Your most recent painted elements: ${truncate(JSON.stringify(recentElements), 1600)}.`
      : "",
    elementHistory.length
      ? `Accumulated element history, oldest to newest and truncated: ${truncate(JSON.stringify(elementHistory), 3000)}.`
      : "",
    promptHistory.length
      ? `User prompt history for this drawing: ${truncate(JSON.stringify(promptHistory), 900)}.`
      : "",
    stats.summary ? `Canvas visual summary: ${truncate(stats.summary, 900)}.` : "",
    "Stream the next batch of SVG elements now.",
  ]
    .filter(Boolean)
    .join("\n");

  const image = includeCanvasImage
    ? payload.canvas.image
    : includeReferenceImage
      ? payload.reference.image
      : null;

  if (!image) {
    return { role: "user", content: text };
  }

  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: image } },
    ],
  };
}

function stripImages(payload) {
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
    return 'This is the last allowed turn for now. Paint visible elements, then end with <batch continue="false" note="..."/>.';
  }

  return [
    "The browser can ask for more passes after this one, up to the turn limit.",
    'If the drawing is complete, end with <batch continue="false" .../> and the browser will stop.',
    'If you want another turn, end with <batch continue="true" .../>.',
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
  ].join("\n");
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

function cleanText(value, maxLength) {
  return truncate(
    String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim(),
    maxLength,
  );
}

function randomNonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
