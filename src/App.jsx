import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const HISTORY_LIMIT = 40;
const RECENT_ELEMENT_LIMIT = 24;
const ELEMENT_HISTORY_LIMIT = 120;
const ELEMENT_SNIPPET_LIMIT = 400;
const PROMPT_HISTORY_LIMIT = 20;
const SVG_NS = "http://www.w3.org/2000/svg";
const CUSTOM_MODEL_OPTION = "__custom__";
const CANVAS_WIDTH = 768;
const CANVAS_HEIGHT = 512;

const ALLOWED_SVG_TAGS = new Set([
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "g",
  "defs",
  "use",
  "symbol",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
  "desc",
]);

function fallbackProviders() {
  return [
    {
      id: "llama",
      label: "Local llama.cpp",
      apiBaseUrl: "http://127.0.0.1:8081",
      model: "gemma-4-26B-A4B-it-Q4_K_M.gguf",
      visionDefault: false,
    },
    {
      id: "openai",
      label: "OpenAI",
      apiBaseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      needsApiKey: true,
      visionDefault: true,
    },
    {
      id: "anthropic",
      label: "Claude",
      apiBaseUrl: "https://api.anthropic.com/v1",
      model: "claude-opus-4-8",
      needsApiKey: true,
      visionDefault: true,
    },
    {
      id: "custom",
      label: "Custom OpenAI-compatible",
      apiBaseUrl: "http://127.0.0.1:8081",
      model: "",
      visionDefault: true,
    },
  ];
}

function initialRuntime() {
  return {
    ws: null,
    undoStack: [],
    elementQueue: [],
    queueRunning: false,
    agentRunning: false,
    modelStreaming: false,
    modelDonePending: false,
    continueRequested: true,
    currentTurn: 0,
    maxTurns: 12,
    noProgressTurns: 0,
    agentSessionStarted: false,
    recentElements: [],
    elementHistory: [],
    promptHistory: [],
    svgDefsById: new Map(),
  };
}

function App() {
  const canvasRef = useRef(null);
  const ctxRef = useRef(null);
  const logRef = useRef(null);
  const fileInputRef = useRef(null);
  const runtimeRef = useRef(initialRuntime());
  const providerDefaultsRef = useRef(new Map());
  const visionUserChangedRef = useRef(false);
  const formRef = useRef(null);

  const [providers, setProviders] = useState(fallbackProviders);
  const [provider, setProvider] = useState("openai");
  const [apiBaseUrl, setApiBaseUrl] = useState("https://api.openai.com/v1");
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState("gpt-4.1-mini");
  const [customModel, setCustomModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [prompt, setPrompt] = useState("");
  const [promptGenerating, setPromptGenerating] = useState(false);
  const [reference, setReference] = useState(null);
  const [referencePreview, setReferencePreview] = useState("");
  const [autoLoop, setAutoLoop] = useState(true);
  const [useVision, setUseVision] = useState(true);
  const [visionSupported, setVisionSupportedState] = useState(false);
  const [maxTurns, setMaxTurns] = useState(12);
  const [status, setStatus] = useState("Idle");
  const [logs, setLogs] = useState([]);
  const [ui, setUi] = useState({
    agentRunning: false,
    modelStreaming: false,
    modelDonePending: false,
    currentTurn: 0,
  });

  const modelOptions = useMemo(() => {
    const ids = new Set(models.map((model) => model.id));
    const options = models.map((model) => ({ value: model.id, label: model.label || model.id }));
    if (selectedModel && selectedModel !== CUSTOM_MODEL_OPTION && !ids.has(selectedModel)) {
      options.unshift({ value: selectedModel, label: selectedModel });
    }
    options.push({ value: CUSTOM_MODEL_OPTION, label: "Custom..." });
    return options;
  }, [models, selectedModel]);

  const currentModel = selectedModel === CUSTOM_MODEL_OPTION ? customModel.trim() : selectedModel;
  const currentDefaults = providerDefaultsRef.current.get(provider) || {};

  formRef.current = {
    provider,
    apiBaseUrl,
    model: currentModel,
    apiKey,
    prompt,
    reference,
    autoLoop,
    useVision,
    maxTurns,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctxRef.current = ctx;
    clearCanvas(false);
    publishAgentApi();
    loadServerConfig();

    return () => {
      const runtime = runtimeRef.current;
      if (runtime.ws?.readyState === WebSocket.OPEN) {
        runtime.ws.close();
      }
    };
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  function patchRuntime(patch) {
    Object.assign(runtimeRef.current, patch);
    const uiPatch = {};
    for (const key of ["agentRunning", "modelStreaming", "modelDonePending", "currentTurn"]) {
      if (key in patch) uiPatch[key] = patch[key];
    }
    if (Object.keys(uiPatch).length > 0) {
      setUi((previous) => ({ ...previous, ...uiPatch }));
    }
  }

  function logEvent(message, kind = "") {
    setLogs((previous) => {
      const next = [...previous, { id: `${Date.now()}-${Math.random()}`, message: String(message), kind }];
      return next.slice(-180);
    });
  }

  function setProviderList(list) {
    const next = Array.isArray(list) && list.length > 0 ? list : fallbackProviders();
    providerDefaultsRef.current = new Map(next.map((item) => [item.id, item]));
    setProviders(next);
  }

  async function loadServerConfig() {
    try {
      const response = await fetch("/api/config", { cache: "no-store" });
      applyServerConfig(await response.json());
    } catch {
      applyServerConfig({});
    }
  }

  function applyServerConfig(config) {
    const nextProviders =
      Array.isArray(config.providers) && config.providers.length > 0
        ? config.providers
        : fallbackProviders();
    setProviderList(nextProviders);

    const nextProvider = config.provider || "openai";
    const defaults = nextProviders.find((item) => item.id === nextProvider) || nextProviders[0] || {};
    const nextBaseUrl = config.apiBaseUrl || defaults.apiBaseUrl || "http://127.0.0.1:8081";
    const nextModel = config.model || defaults.model || "";

    setProvider(nextProvider);
    setApiBaseUrl(nextBaseUrl);
    applyVisionSupported(Boolean(config.visionSupported));
    setModelSelection([], nextModel);
    refreshModelList({
      providerId: nextProvider,
      baseUrl: nextBaseUrl,
      key: "",
      selected: nextModel,
    });
  }

  function applyVisionSupported(supported) {
    setVisionSupportedState(supported);
    if (!visionUserChangedRef.current) {
      setUseVision(supported);
    }
  }

  function setModelSelection(nextModels, selected) {
    const cleanModels = Array.isArray(nextModels) ? nextModels : [];
    setModels(cleanModels);

    if (selected) {
      setSelectedModel(selected);
      if (selected === CUSTOM_MODEL_OPTION) setCustomModel("");
      return;
    }

    setSelectedModel(cleanModels[0]?.id || CUSTOM_MODEL_OPTION);
  }

  async function refreshModelList({ providerId, baseUrl, key, selected }) {
    const fallback = selected || providerDefaultsRef.current.get(providerId)?.model || "";
    setModelSelection([], fallback);

    try {
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: providerId,
          apiBaseUrl: baseUrl,
          apiKey: key,
        }),
      });
      const payload = await response.json();
      if (payload.models?.length) {
        setModelSelection(payload.models, fallback);
        logEvent(`models: ${payload.models.length} available`);
      } else if (payload.error) {
        logEvent(`model list unavailable: ${payload.error}`, "warn");
      }
    } catch {
      logEvent("model list request failed; use Custom... for a model id", "warn");
    }
  }

  function handleProviderChange(nextProvider) {
    const defaults = providerDefaultsRef.current.get(nextProvider);
    if (!defaults) return;

    const nextBaseUrl = defaults.apiBaseUrl || "";
    const nextModel = defaults.model || "";
    setProvider(nextProvider);
    setApiBaseUrl(nextBaseUrl);
    setApiKey("");
    visionUserChangedRef.current = false;
    setVisionSupportedState(Boolean(defaults.visionDefault));
    setUseVision(Boolean(defaults.visionDefault));
    setModelSelection([], nextModel);
    logEvent(`provider: ${defaults.label}`);
    refreshModelList({
      providerId: nextProvider,
      baseUrl: nextBaseUrl,
      key: "",
      selected: nextModel,
    });
  }

  function handleModelChange(value) {
    if (value === CUSTOM_MODEL_OPTION && selectedModel !== CUSTOM_MODEL_OPTION) {
      setCustomModel(currentModel || "");
    }
    setSelectedModel(value);
  }

  function handleApiBaseUrlChange(value) {
    setApiBaseUrl(value);
  }

  function handleApiBaseUrlBlur() {
    const form = formRef.current;
    refreshModelList({
      providerId: form.provider,
      baseUrl: form.apiBaseUrl,
      key: form.apiKey,
      selected: form.model,
    });
  }

  function handleApiKeyBlur() {
    const form = formRef.current;
    refreshModelList({
      providerId: form.provider,
      baseUrl: form.apiBaseUrl,
      key: form.apiKey,
      selected: form.model,
    });
  }

  async function handleReferenceFile(file) {
    if (!file) {
      setReference(null);
      setReferencePreview("");
      return;
    }

    try {
      const payload = await downscaleImageFile(file, 512, 0.78);
      setReference(payload);
      setReferencePreview(payload.image);
      logEvent(`reference loaded: ${file.name}`);
    } catch (error) {
      setReference(null);
      setReferencePreview("");
      logEvent(error.message || String(error), "error");
    }
  }

  async function generatePrompt() {
    setPromptGenerating(true);
    logEvent("generating prompt");

    try {
      const response = await fetch("/api/random-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: getModelConfig() }),
      });
      const payload = await response.json();
      if (!response.ok || payload.error) {
        throw new Error(payload.error || `Prompt request returned ${response.status}`);
      }
      setPrompt(payload.prompt || "");
      logEvent("prompt generated");
    } catch (error) {
      logEvent(error.message || String(error), "error");
    } finally {
      setPromptGenerating(false);
    }
  }

  function publishAgentApi() {
    window.paintAgent = {
      svg: (markup) => enqueueSvgElement(String(markup)),
      clear: () => clearCanvas(true),
      undo,
      exportPng,
      snapshot: captureCanvasFeedback,
    };
  }

  function saveUndo() {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    const runtime = runtimeRef.current;
    runtime.undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (runtime.undoStack.length > HISTORY_LIMIT) runtime.undoStack.shift();
  }

  function undo(count = 1) {
    const runtime = runtimeRef.current;
    let steps = clampInt(count, 1, 8, 1);
    while (steps > 0 && runtime.undoStack.length > 0) {
      ctxRef.current.putImageData(runtime.undoStack.pop(), 0, 0);
      steps -= 1;
    }
  }

  function clearCanvas(remember = true) {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    if (remember) saveUndo();
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function exportPng() {
    const exportedAt = new Date().toISOString();
    const filenameBase = `agent-paint-${exportedAt.replace(/[:.]/g, "-")}`;
    downloadDataUrl(`${filenameBase}.png`, canvasRef.current.toDataURL("image/png"));
    downloadJson(`${filenameBase}.json`, createExportMetadata(exportedAt));
  }

  function createExportMetadata(exportedAt) {
    const form = formRef.current;
    const canvas = canvasRef.current;
    return {
      prompt: form.prompt.trim(),
      author: "",
      provider: form.provider,
      model: form.model,
      turns: runtimeRef.current.currentTurn,
      createdAt: exportedAt,
      canvas: {
        width: canvas.width,
        height: canvas.height,
      },
    };
  }

  function enqueueSvgElement(markup) {
    const sanitized = sanitizeSvgMarkup(markup);
    if (!sanitized) {
      logEvent("blocked unsafe or malformed SVG element", "warn");
      return false;
    }
    runtimeRef.current.elementQueue.push(sanitized);
    runElementQueue();
    return true;
  }

  async function runElementQueue() {
    const runtime = runtimeRef.current;
    if (runtime.queueRunning) return;
    runtime.queueRunning = true;

    while (runtime.elementQueue.length > 0) {
      const markup = runtime.elementQueue.shift();
      saveUndo();
      rememberAgentElement(markup);
      try {
        await paintSvgElement(markup);
      } catch {
        logEvent("element failed to render", "warn");
      }
      await delay(110);
    }

    runtime.queueRunning = false;
    maybeContinueAgent();
  }

  function sanitizeSvgMarkup(markup) {
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="${SVG_NS}">${markup}</svg>`,
      "image/svg+xml",
    );
    if (doc.querySelector("parsererror")) return null;

    const root = doc.documentElement;
    for (const el of [...root.querySelectorAll("*")]) {
      if (!ALLOWED_SVG_TAGS.has(el.localName)) {
        el.remove();
        continue;
      }
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith("on") || /javascript:/i.test(value)) {
          el.removeAttribute(attr.name);
        } else if ((name === "href" || name.endsWith(":href")) && !value.startsWith("#")) {
          el.removeAttribute(attr.name);
        } else if (/url\s*\(/i.test(value) && !/url\s*\(\s*["']?#/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      }
    }

    const serializer = new XMLSerializer();
    const runtime = runtimeRef.current;
    for (const def of root.querySelectorAll("linearGradient, radialGradient, symbol")) {
      if (def.id) {
        runtime.svgDefsById.set(def.id, serializer.serializeToString(def));
        if (runtime.svgDefsById.size > 80) {
          runtime.svgDefsById.delete(runtime.svgDefsById.keys().next().value);
        }
      }
    }

    const result = [...root.childNodes].map((node) => serializer.serializeToString(node)).join("");
    return result.trim() || null;
  }

  function paintSvgElement(markup) {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    const defs = runtimeRef.current.svgDefsById.size
      ? `<defs>${[...runtimeRef.current.svgDefsById.values()].join("")}</defs>`
      : "";
    const svg = `<svg xmlns="${SVG_NS}" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${defs}${markup}</svg>`;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    return loadImage(url)
      .then((image) => {
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      })
      .finally(() => URL.revokeObjectURL(url));
  }

  function rememberAgentElement(markup) {
    const runtime = runtimeRef.current;
    const snippet =
      markup.length > ELEMENT_SNIPPET_LIMIT ? `${markup.slice(0, ELEMENT_SNIPPET_LIMIT)}...` : markup;
    runtime.recentElements.push(snippet);
    runtime.elementHistory.push(snippet);
    if (runtime.recentElements.length > RECENT_ELEMENT_LIMIT) runtime.recentElements.shift();
    if (runtime.elementHistory.length > ELEMENT_HISTORY_LIMIT) runtime.elementHistory.shift();
  }

  async function startAgent() {
    await ensureSocket();
    const runtime = runtimeRef.current;
    if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) return;

    const form = formRef.current;
    const hasExistingSession = runtime.agentSessionStarted && runtime.elementHistory.length > 0;
    const mode = hasExistingSession ? "edit" : "new";
    const cleanPrompt = form.prompt.trim();
    const isBlankNewPrompt = mode === "new" && cleanPrompt.length === 0;

    runtime.maxTurns = runtime.currentTurn + clampInt(form.maxTurns, 1, 40, 12);
    runtime.noProgressTurns = 0;
    runtime.agentSessionStarted = true;
    rememberPrompt(cleanPrompt, mode);

    patchRuntime({
      agentRunning: true,
      modelDonePending: false,
      continueRequested: true,
    });
    logEvent(hasExistingSession ? "sending edit prompt" : "starting new agent drawing");

    runtime.ws.send(
      JSON.stringify({
        type: hasExistingSession ? "feedback" : "start",
        mode,
        prompt: cleanPrompt,
        choiceNonce: isBlankNewPrompt ? randomNonce() : "",
        config: getModelConfig(),
        useVision: form.useVision,
        canvas: await captureCanvasFeedback(form.useVision),
        reference: form.reference,
        recentElements: runtime.recentElements,
        elementHistory: runtime.elementHistory,
        promptHistory: runtime.promptHistory,
        turnBudget: getTurnBudgetPayload(),
      }),
    );

    runtime.recentElements = [];
  }

  async function sendFeedbackStep() {
    await ensureSocket();
    const runtime = runtimeRef.current;
    if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN || runtime.modelStreaming) return;

    const form = formRef.current;
    runtime.agentSessionStarted = true;
    patchRuntime({ agentRunning: true });
    logEvent("sending feedback step");

    runtime.ws.send(
      JSON.stringify({
        type: "feedback",
        mode: "continue",
        prompt: form.prompt,
        config: getModelConfig(),
        useVision: form.useVision,
        canvas: await captureCanvasFeedback(form.useVision),
        reference: form.reference,
        recentElements: runtime.recentElements,
        elementHistory: runtime.elementHistory,
        promptHistory: runtime.promptHistory,
        turnBudget: getTurnBudgetPayload(),
      }),
    );

    runtime.recentElements = [];
  }

  function stopAgent() {
    const runtime = runtimeRef.current;
    runtime.noProgressTurns = 0;
    if (runtime.ws?.readyState === WebSocket.OPEN) {
      runtime.ws.send(JSON.stringify({ type: "stop" }));
    }
    patchRuntime({
      agentRunning: false,
      modelStreaming: false,
      modelDonePending: false,
      continueRequested: false,
    });
    setStatus("Stopped");
  }

  function resetAgentSession({ clear = false } = {}) {
    stopAgent();
    if (clear) clearCanvas(true);
    const runtime = runtimeRef.current;
    Object.assign(runtime, {
      agentSessionStarted: false,
      modelDonePending: false,
      continueRequested: true,
      currentTurn: 0,
      maxTurns: clampInt(formRef.current.maxTurns, 1, 40, 12),
      noProgressTurns: 0,
      recentElements: [],
      elementHistory: [],
      promptHistory: [],
    });
    runtime.svgDefsById.clear();
    patchRuntime({
      agentRunning: false,
      modelStreaming: false,
      modelDonePending: false,
      currentTurn: 0,
    });
    setStatus(clear ? "New canvas" : "Agent reset");
    logEvent(clear ? "new canvas and agent memory reset" : "agent memory reset");
    if (clear && fileInputRef.current) {
      fileInputRef.current.value = "";
      setReference(null);
      setReferencePreview("");
    }
  }

  async function ensureSocket() {
    const runtime = runtimeRef.current;
    if (runtime.ws?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    runtime.ws = new WebSocket(`${protocol}//${window.location.host}/agent`);

    await new Promise((resolve) => {
      runtime.ws.addEventListener("open", resolve, { once: true });
      runtime.ws.addEventListener(
        "error",
        () => {
          logEvent("could not open agent socket", "error");
          resolve();
        },
        { once: true },
      );
    });

    runtime.ws.addEventListener("message", handleSocketMessage);
    runtime.ws.addEventListener("close", () => {
      patchRuntime({
        agentRunning: false,
        modelStreaming: false,
        modelDonePending: false,
      });
      setStatus("Socket closed");
    });
  }

  function handleSocketMessage(event) {
    const message = JSON.parse(event.data);
    const runtime = runtimeRef.current;

    if (message.type === "hello") {
      if (message.providers) setProviderList(message.providers);
      applyVisionSupported(Boolean(message.visionSupported));
      return;
    }

    if (message.type === "modelStart") {
      runtime.currentTurn = message.turn;
      patchRuntime({
        modelStreaming: true,
        modelDonePending: false,
        currentTurn: message.turn,
        continueRequested: true,
      });
      setStatus(`Turn ${message.turn}: streaming`);
      logEvent(`model start: ${message.model || ""} via ${message.providerLabel || message.provider}`);
      if (message.usingVision) logEvent("vision feedback included");
      return;
    }

    if (message.type === "element") {
      logEvent(message.markup, "command");
      enqueueSvgElement(message.markup);
      return;
    }

    if (message.type === "batch") {
      runtime.continueRequested = Boolean(message.continue);
      if (message.note) logEvent(`batch: ${message.note}`);
      return;
    }

    if (message.type === "modelWarning") {
      logEvent(message.message, "warn");
      return;
    }

    if (message.type === "modelDone") {
      runtime.noProgressTurns =
        message.elementsThisTurn > 0 ? 0 : runtime.noProgressTurns + 1;
      patchRuntime({
        modelStreaming: false,
        modelDonePending: true,
        continueRequested: Boolean(message.continue),
      });
      setStatus(
        message.aborted
          ? "Stopped"
          : `Turn ${message.turn} done: ${message.elementsThisTurn} elements`,
      );
      logEvent(`model done: ${message.elementsThisTurn} elements`);
      if (message.retriedWithoutVision) {
        logEvent("completed after retrying without screenshots", "warn");
      }
      maybeContinueAgent();
      return;
    }

    if (message.type === "status") {
      logEvent(message.message);
      return;
    }

    if (message.type === "error") {
      patchRuntime({
        modelStreaming: false,
        modelDonePending: false,
        agentRunning: false,
      });
      setStatus("Error");
      logEvent(message.message, "error");
    }
  }

  async function maybeContinueAgent() {
    const runtime = runtimeRef.current;
    const form = formRef.current;
    if (!runtime.agentRunning || !form.autoLoop) return;
    if (runtime.queueRunning || runtime.modelStreaming || !runtime.modelDonePending) return;

    if (runtime.noProgressTurns >= 2) {
      patchRuntime({ agentRunning: false, modelDonePending: false });
      setStatus("Stopped: no progress");
      logEvent("stopped after two empty model batches", "warn");
      return;
    }

    if (!runtime.continueRequested) {
      patchRuntime({ agentRunning: false, modelDonePending: false });
      setStatus("Finished");
      logEvent("model chose to stop");
      return;
    }

    if (runtime.currentTurn >= runtime.maxTurns) {
      patchRuntime({ agentRunning: false, modelDonePending: false });
      setStatus("Max turns reached");
      return;
    }

    runtime.modelDonePending = false;
    patchRuntime({ modelDonePending: false });
    await delay(250);
    await sendFeedbackStep();
  }

  function getTurnBudgetPayload() {
    const runtime = runtimeRef.current;
    return {
      currentTurn: runtime.currentTurn,
      maxTurns: runtime.maxTurns,
      remainingAfterThisRequest: Math.max(0, runtime.maxTurns - runtime.currentTurn - 1),
      autoLoop: formRef.current.autoLoop,
    };
  }

  function getModelConfig() {
    const form = formRef.current;
    return {
      provider: form.provider,
      apiBaseUrl: form.apiBaseUrl.trim(),
      model: form.model,
      apiKey: form.apiKey.trim(),
      maxTokens: 2000,
    };
  }

  async function captureCanvasFeedback(includeImage = false) {
    const canvas = canvasRef.current;
    const payload = {
      width: canvas.width,
      height: canvas.height,
      stats: summarizeCanvas(),
    };
    if (includeImage) {
      payload.image = await canvasToDataUrl(canvas, 384, 0.72);
    }
    return payload;
  }

  function summarizeCanvas() {
    const canvas = canvasRef.current;
    const sampleWidth = 96;
    const sampleHeight = 64;
    const scratch = document.createElement("canvas");
    scratch.width = sampleWidth;
    scratch.height = sampleHeight;
    const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
    scratchCtx.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
    const data = scratchCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;

    let marked = 0;
    let minX = sampleWidth;
    let minY = sampleHeight;
    let maxX = 0;
    let maxY = 0;
    const buckets = new Map();

    for (let y = 0; y < sampleHeight; y += 1) {
      for (let x = 0; x < sampleWidth; x += 1) {
        const index = (y * sampleWidth + x) * 4;
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const a = data[index + 3];
        const isWhite = a < 12 || (r > 244 && g > 244 && b > 244);
        if (isWhite) continue;

        marked += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        const key = [
          Math.round(r / 32) * 32,
          Math.round(g / 32) * 32,
          Math.round(b / 32) * 32,
        ].join(",");
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
    }

    const dominant = [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key, count]) => {
        const [r, g, b] = key.split(",").map((value) => clampInt(value, 0, 255, 0));
        return { color: rgbToHex(r, g, b), count };
      });

    const coverage = marked / (sampleWidth * sampleHeight);
    const bbox =
      marked === 0
        ? null
        : {
            x: Math.round((minX / sampleWidth) * canvas.width),
            y: Math.round((minY / sampleHeight) * canvas.height),
            w: Math.round(((maxX - minX + 1) / sampleWidth) * canvas.width),
            h: Math.round(((maxY - minY + 1) / sampleHeight) * canvas.height),
          };

    return {
      coverage,
      bbox,
      dominant,
      summary:
        marked === 0
          ? "blank white canvas"
          : `non-white coverage ${(coverage * 100).toFixed(1)}%, bounding box ${JSON.stringify(
              bbox,
            )}, dominant colors ${dominant.map((item) => item.color).join(", ")}`,
    };
  }

  function rememberPrompt(nextPrompt, mode) {
    const runtime = runtimeRef.current;
    runtime.promptHistory.push({
      mode,
      turn: runtime.currentTurn,
      prompt: (nextPrompt || "(agent chose subject)").slice(0, 240),
    });
    if (runtime.promptHistory.length > PROMPT_HISTORY_LIMIT) {
      runtime.promptHistory.shift();
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span>Agent Paint</span>
          </div>
          <nav className="nav-tabs" aria-label="Primary">
            <a className="nav-tab active" href="/">
              Paint
            </a>
            <a className="nav-tab" href="/gallery">
              Gallery
            </a>
          </nav>
        </div>
        <div className="file-actions" aria-label="File actions">
          <button type="button" title="Export PNG" onClick={exportPng}>
            Export
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="canvas-stage" aria-label="Canvas workspace">
          <div className="canvas-frame">
            <canvas ref={canvasRef} id="paintCanvas" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} />
          </div>
          <div className="status-row">
            <span>{CANVAS_WIDTH} x {CANVAS_HEIGHT}</span>
            <span>{status}</span>
          </div>
        </section>

        <aside className="agent-panel" aria-label="Agent controls">
          <section className="panel-section">
            <div className="panel-heading">
              <h1>Agent</h1>
              <div className="panel-actions" aria-label="Agent actions">
                <button className="primary" type="button" disabled={ui.modelStreaming} onClick={startAgent}>
                  Send
                </button>
                <button type="button" disabled={!ui.agentRunning && !ui.modelStreaming} onClick={stopAgent}>
                  Stop
                </button>
                <button type="button" disabled={ui.modelStreaming} onClick={() => resetAgentSession({ clear: true })}>
                  New
                </button>
              </div>
            </div>
            <label className="field compact">
              <span>provider</span>
              <select value={provider} onChange={(event) => handleProviderChange(event.target.value)}>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>API base URL</span>
              <input
                value={apiBaseUrl}
                onChange={(event) => handleApiBaseUrlChange(event.target.value)}
                onBlur={handleApiBaseUrlBlur}
                type="url"
                spellCheck="false"
              />
            </label>
            <label className="field compact">
              <span>model</span>
              <select value={selectedModel || CUSTOM_MODEL_OPTION} onChange={(event) => handleModelChange(event.target.value)}>
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {selectedModel === CUSTOM_MODEL_OPTION ? (
                <input
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  type="text"
                  spellCheck="false"
                  placeholder="model id"
                />
              ) : null}
            </label>
            <label className="field compact">
              <span>API key</span>
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                onBlur={handleApiKeyBlur}
                type="password"
                spellCheck="false"
                autoComplete="off"
                placeholder={currentDefaults.needsApiKey ? "Uses provider env var if blank" : "Optional for local endpoints"}
              />
            </label>
          </section>

          <section className="panel-section">
            <label className="field">
              <div className="field-heading">
                <span>Prompt</span>
                <button type="button" disabled={promptGenerating || ui.modelStreaming} onClick={generatePrompt}>
                  {promptGenerating ? "Generating" : "Random"}
                </button>
              </div>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                placeholder="Blank means the agent chooses what to draw."
              />
            </label>
            <label className="field">
              <span>Reference image</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={(event) => handleReferenceFile(event.target.files?.[0])}
              />
            </label>
            <div className="reference-preview" aria-live="polite">
              {referencePreview ? <img src={referencePreview} alt="Reference preview" /> : null}
            </div>
          </section>

          <section className="panel-section options">
            <label>
              <input
                type="checkbox"
                checked={autoLoop}
                onChange={(event) => setAutoLoop(event.target.checked)}
              />
              Auto feedback loop
            </label>
            <label title={visionSupported ? "Canvas screenshots are sent to the provider on each agent turn." : "The current endpoint has not reported vision support."}>
              <input
                type="checkbox"
                checked={useVision}
                onChange={(event) => {
                  visionUserChangedRef.current = true;
                  setUseVision(event.target.checked);
                }}
              />
              Send screenshots to model
            </label>
            <label className="field compact">
              <span>turn limit</span>
              <input
                type="number"
                min="1"
                max="40"
                value={maxTurns}
                onChange={(event) => setMaxTurns(clampInt(event.target.value, 1, 40, 12))}
              />
            </label>
          </section>

          <section className="panel-section log-section">
            <h2>Stream</h2>
            <div ref={logRef} className="event-log" aria-live="polite">
              {logs.map((entry) => (
                <div key={entry.id} className={entry.kind}>
                  {entry.message}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

async function canvasToDataUrl(source, maxSize, quality) {
  const scale = Math.min(1, maxSize / Math.max(source.width, source.height));
  const scratch = document.createElement("canvas");
  scratch.width = Math.max(1, Math.round(source.width * scale));
  scratch.height = Math.max(1, Math.round(source.height * scale));
  const scratchCtx = scratch.getContext("2d");
  scratchCtx.fillStyle = "#ffffff";
  scratchCtx.fillRect(0, 0, scratch.width, scratch.height);
  scratchCtx.drawImage(source, 0, 0, scratch.width, scratch.height);
  return scratch.toDataURL("image/jpeg", quality);
}

async function downscaleImageFile(file, maxSize, quality) {
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImage(dataUrl);
  const scratch = document.createElement("canvas");
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  scratch.width = Math.max(1, Math.round(image.naturalWidth * scale));
  scratch.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const scratchCtx = scratch.getContext("2d");
  scratchCtx.fillStyle = "#ffffff";
  scratchCtx.fillRect(0, 0, scratch.width, scratch.height);
  scratchCtx.drawImage(image, 0, 0, scratch.width, scratch.height);
  return {
    width: scratch.width,
    height: scratch.height,
    image: scratch.toDataURL("image/jpeg", quality),
  };
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Could not load image.")));
    image.src = src;
  });
}

function downloadDataUrl(filename, href) {
  const link = document.createElement("a");
  link.download = filename;
  link.href = href;
  link.click();
}

function downloadJson(filename, payload) {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }),
  );
  try {
    downloadDataUrl(filename, url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((value) => clampInt(value, 0, 255, 0).toString(16).padStart(2, "0"))
    .join("")}`;
}

function randomNonce() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampInt(value, min, max, fallback = min) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

createRoot(document.querySelector("#root")).render(<App />);
