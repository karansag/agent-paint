import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const ROOT_DIR = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT_DIR, "public");

const PORT = Number(process.env.PORT || 5173);
const LLAMA_SERVER_ENV_URL = process.env.LLAMA_SERVER_URL || process.env.OPENAI_BASE_URL || "";
const LLAMA_MODEL_ENV = process.env.LLAMA_MODEL || process.env.MODEL || "";
const DEFAULT_LLAMA_CHAT_PATH = process.env.LLAMA_CHAT_PATH || "/v1/chat/completions";
const DEFAULT_MAX_TOKENS = Number(process.env.LLAMA_MAX_TOKENS || 1400);
const MAX_HISTORY_MESSAGES = 15;
const STARTUP_LLAMA_CONFIG = await resolveStartupLlamaConfig();
const DEFAULT_LLAMA_SERVER_URL = STARTUP_LLAMA_CONFIG.llamaServerUrl;
const DEFAULT_MODEL = STARTUP_LLAMA_CONFIG.model;

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
- Avoid tiny details until the main subject is recognizable.
- For edit requests, preserve the existing drawing. Do not redraw the whole scene, erase it, paint over it with white, or cover existing objects with large filled shapes unless the user explicitly asks.
- For blank new requests, choose what to draw yourself. There is no hidden target and no preferred theme.`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/config") {
      const visionSupported = await detectVisionSupport(DEFAULT_LLAMA_SERVER_URL);
      sendJson(res, {
        llamaServerUrl: DEFAULT_LLAMA_SERVER_URL,
        llamaChatPath: DEFAULT_LLAMA_CHAT_PATH,
        model: DEFAULT_MODEL,
        visionSupported,
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

  send(ws, "hello", {
    llamaServerUrl: DEFAULT_LLAMA_SERVER_URL,
    llamaChatPath: DEFAULT_LLAMA_CHAT_PATH,
    model: DEFAULT_MODEL,
    visionSupported: await detectVisionSupport(DEFAULT_LLAMA_SERVER_URL),
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
  console.log(`Default llama-server URL: ${DEFAULT_LLAMA_SERVER_URL}${DEFAULT_LLAMA_CHAT_PATH}`);
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

  const config = normalizeModelConfig(payload.config);
  session.width = clampInt(payload.canvas?.width, 128, 2048, session.width);
  session.height = clampInt(payload.canvas?.height, 128, 2048, session.height);
  const visionSupported = payload.useVision ? await detectVisionSupport(config.baseUrl) : false;
  const effectivePayload = {
    ...payload,
    useVision: Boolean(payload.useVision && visionSupported),
  };

  if (payload.useVision && !visionSupported) {
    send(ws, "modelWarning", {
      message: "Screenshots were requested, but llama-server does not currently report vision support.",
    });
  }

  const userMessage = buildUserMessage(effectivePayload, session);
  session.messages.push(userMessage);
  trimConversation(session);

  const requestBody = {
    model: config.model,
    messages: session.messages,
    stream: true,
    temperature: config.temperature,
    max_tokens: config.maxTokens,
  };
  if (config.seed !== null) requestBody.seed = config.seed;
  addSamplingParams(requestBody, config);
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
    endpoint: `${config.baseUrl}${config.chatPath}`,
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
    session.messages.push({ role: "assistant", content: session.lastAssistantText });
    trimConversation(session);

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
        session.messages[session.messages.length - 1] = buildUserMessage(fallbackPayload, session);
        requestBody.messages = session.messages;

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
        session.messages.push({ role: "assistant", content: session.lastAssistantText });
        trimConversation(session);

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
  const response = await fetch(`${config.baseUrl}${config.chatPath}`, {
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
      `llama-server returned ${response.status}: ${truncate(errorText || response.statusText, 1200)}`,
    );
  }

  if (!response.body) {
    throw new Error("llama-server response did not include a readable stream.");
  }

  for await (const content of readOpenAIContentStream(response.body)) {
    onContent(content);
  }
}

function normalizeModelConfig(input = {}) {
  const baseUrl = normalizeBaseUrl(input.llamaServerUrl || DEFAULT_LLAMA_SERVER_URL);
  const chatPath = normalizePath(input.llamaChatPath || DEFAULT_LLAMA_CHAT_PATH);

  return {
    baseUrl,
    chatPath,
    model: String(input.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    apiKey: String(input.apiKey || process.env.OPENAI_API_KEY || "").trim(),
    temperature: clampNumber(input.temperature, 0, 2, 0.65),
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

function addSamplingParams(requestBody, config) {
  const mappings = [
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
  ];

  for (const [key, value] of mappings) {
    if (value !== null) requestBody[key] = value;
  }
}

async function resolveStartupLlamaConfig() {
  const fallbackUrl = "http://127.0.0.1:8081";
  const fallbackModel = LLAMA_MODEL_ENV || "gemma-4-26B-A4B-it-Q4_K_M.gguf";

  if (LLAMA_SERVER_ENV_URL) {
    const llamaServerUrl = normalizeBaseUrl(LLAMA_SERVER_ENV_URL);
    return {
      llamaServerUrl,
      model: LLAMA_MODEL_ENV || (await detectModelName(llamaServerUrl)) || fallbackModel,
    };
  }

  for (const candidate of ["http://127.0.0.1:8081", "http://127.0.0.1:8080"]) {
    if (await isLlamaServerHealthy(candidate)) {
      return {
        llamaServerUrl: candidate,
        model: LLAMA_MODEL_ENV || (await detectModelName(candidate)) || fallbackModel,
      };
    }
  }

  return {
    llamaServerUrl: fallbackUrl,
    model: fallbackModel,
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

async function detectVisionSupport(baseUrl) {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/props`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return false;

    const payload = await response.json();
    return Boolean(payload.modalities?.vision);
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || DEFAULT_LLAMA_SERVER_URL).trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("llama-server URL must start with http:// or https://.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizePath(value) {
  const path = String(value || DEFAULT_LLAMA_CHAT_PATH).trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function buildUserMessage(payload, session) {
  const prompt = truncate(String(payload.prompt || "").trim(), 1200);
  const mode = ["new", "edit", "continue"].includes(payload.mode) ? payload.mode : "continue";
  const recentActions = Array.isArray(payload.recentActions)
    ? payload.recentActions.slice(-24)
    : [];
  const historyActions = Array.isArray(payload.historyActions)
    ? payload.historyActions.slice(-120)
    : [];
  const promptHistory = Array.isArray(payload.promptHistory)
    ? payload.promptHistory.slice(-12)
    : [];
  const stats = payload.canvas?.stats || {};
  const turnBudget = normalizeTurnBudget(payload.turnBudget);
  const modeInstruction =
    mode === "edit"
      ? "This is an edit to the existing drawing. Preserve all existing objects. Add only the requested new elements. If something should appear behind an existing object, draw it around the object or as visible edge lines instead of covering the object."
      : mode === "new"
        ? "This is a new drawing request. Establish the main subject clearly."
        : "Continue refining the existing drawing. Preserve what is already on the canvas.";
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
    payload.useVision && payload.canvas?.image
      ? "A current canvas screenshot is attached. Use the screenshot as the source of truth for what is already drawn."
      : "",
    payload.useVision && payload.reference?.image
      ? "A user reference image is also attached."
      : "",
    `Recent executed commands: ${truncate(JSON.stringify(recentActions), 2200)}.`,
    historyActions.length
      ? `Accumulated drawing command history, oldest to newest and truncated: ${truncate(JSON.stringify(historyActions), 6500)}.`
      : "",
    promptHistory.length
      ? `User prompt history for this drawing: ${truncate(JSON.stringify(promptHistory), 1800)}.`
      : "",
    stats.summary ? `Canvas visual summary: ${truncate(stats.summary, 1800)}.` : "",
    "Return the next batch now as JSON objects only.",
  ]
    .filter(Boolean)
    .join("\n");

  const images = [];
  if (payload.useVision && payload.canvas?.image) {
    images.push({
      type: "image_url",
      image_url: { url: payload.canvas.image },
    });
  }
  if (payload.useVision && payload.reference?.image) {
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

function trimConversation(session) {
  if (session.messages.length <= MAX_HISTORY_MESSAGES) return;
  const system = session.messages[0];
  const tail = session.messages.slice(-(MAX_HISTORY_MESSAGES - 1));
  session.messages = [system, ...tail];
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
