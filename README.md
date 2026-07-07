# Agent Paint

An agent-driven canvas with a live drawing loop for any OpenAI-compatible chat API.

The model draws by streaming **raw SVG**. Each complete element (`<path>`, `<circle>`, `<g>`, gradients, `<text>`, ...) is painted onto the canvas the moment its closing tag arrives, so the drawing builds up live. There are no manual paint tools; the canvas belongs to the model. After each batch the browser can send a downscaled canvas screenshot and a compact visual summary back to the model, so the agent can continue or correct its work.

Giving the model SVG instead of a fixed set of paint primitives means it can draw anything it can describe (Bezier curves, gradients, transforms, opacity), and its own taste shows through. The system prompt tells the model who it is and explicitly asks for its own style.

The frontend is a React app (`src/App.jsx`) bundled with esbuild into `public/app.js`. The backend is a plain Node HTTP + WebSocket server (`server.js`).

## Run

```bash
npm install
npm start       # builds the frontend, then serves http://localhost:5173
npm run dev     # same, with the server in --watch mode
npm test        # unit tests for the SVG parser, provider config, and key policy
```

`npm start` runs the esbuild bundle step first, then `node server.js`. To rebuild the frontend alone, use `npm run build`.

The default provider is **OpenAI** (`OPENAI_API_KEY` required). To use a local Gemma served by llama.cpp instead, set `LLM_PROVIDER=llama`; the backend then probes ports `8081` then `8080` and uses the first healthy endpoint.

Environment overrides:

```bash
OPENAI_API_KEY=...    npm start                                   # default provider
ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic npm start
LLM_PROVIDER=llama LLM_BASE_URL=http://127.0.0.1:8081 LLM_MODEL=gemma-4-26B-A4B-it-Q4_K_M.gguf npm start
```

A `.env` file in the project root is loaded automatically (via `node --env-file-if-exists`).

Recognized variables: `PORT`, `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_MAX_TOKENS`, `KEY_MODE` plus the `DEMO_*` limits (see below), and the per-provider key vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `LLAMA_API_KEY`, or generic `LLM_API_KEY`). Provider, base URL, model, and API key can also be changed in the UI per request.

## Key sharing and rate limits

`KEY_MODE` controls whether visitors may spend the API keys in the server's environment:

- `open` (default) — env keys fill in whenever the browser omits one, with no limits. For local use.
- `demo` — env keys work, but model turns that use them are rate limited: `DEMO_TURNS_PER_HOUR` per visitor IP (default 20), `DEMO_TURNS_PER_DAY` total (default 400), and `max_tokens` clamped to `DEMO_MAX_TOKENS` (default 2000). Visitors who paste their own key are not limited.
- `byok` — bring your own key: env keys are never used for visitor requests.

In every mode, a server key is only attached when the request targets that provider's own endpoint (or the operator's configured `LLM_BASE_URL`). A base URL typed into the UI never receives a server key, so a visitor cannot redirect one to a host they control.

## Deploy

The drawing loop runs over a WebSocket (`/agent`), so the app needs a host that keeps a Node process alive. Serverless platforms like Vercel that do not support persistent WebSocket servers will not run the drawing loop without a transport rewrite.

A `render.yaml` blueprint is included for [Render](https://render.com), whose free tier supports WebSockets:

1. Push this repo to GitHub.
2. In Render, choose **New > Blueprint** and select the repo. Render reads `render.yaml`, builds with `npm install && npm run build`, and starts `node server.js`.
3. Set `OPENAI_API_KEY` (and any other secrets) when Render prompts for it.

The blueprint sets `KEY_MODE=demo`, so visitors can try the shared key within the rate limits and paste their own key for unlimited use. For a zero-cost deploy, set `KEY_MODE=byok` and skip the key secrets entirely.

Render injects `PORT`, which the server already reads. The same setup works on any persistent-process host (Railway, Fly.io, a VM); only the platform config differs. Note the Render free tier idles after inactivity and cold-starts on the next request.

## Providers

- **Local llama.cpp**: `http://127.0.0.1:8081/v1/chat/completions`; vision support is probed via `/props`, model name via `/v1/models`
- **OpenAI**: `https://api.openai.com/v1/chat/completions`
- **Claude**: Anthropic's OpenAI-compatible endpoint, `https://api.anthropic.com/v1/chat/completions` (default model `claude-opus-4-8`)
- **Custom OpenAI-compatible**: any base URL and model (the chat path is fixed per provider and is not user-configurable)

The model field is a dropdown populated live from the provider (`/v1/models` for llama.cpp/OpenAI/custom, the native models API for Anthropic), with a `Custom...` option for typing an arbitrary model id. The list refreshes when you change provider, base URL, or API key.

The UI does not expose sampling controls. Hosted OpenAI and Anthropic requests do not include `temperature`, `top_p`, `top_k`, or `min_p`.

## Drawing protocol

The model is prompted to stream SVG elements, nothing else:

```xml
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#f8fafc"/>
</linearGradient></defs>
<rect x="0" y="0" width="768" height="512" fill="url(#sky)"/>
<path d="M0 380 C 180 300, 420 340, 768 290 L 768 512 L 0 512 Z" fill="#16a34a"/>
<batch continue="true" note="add the lighthouse next"/>
```

- Allowed elements: `path rect circle ellipse line polyline polygon text tspan g defs use symbol linearGradient radialGradient stop`
- An `<svg>` wrapper, comments, markdown fences, and prose are tolerated and ignored
- `<batch continue="true|false" note="..."/>` ends a batch and drives the auto feedback loop
- Gradients and symbols persist for the rest of the session, so later elements can reference them
- The server screens elements (tag allowlist, no event handlers, no `javascript:`), and the browser re-sanitizes with a real XML parser before painting; the canvas is never tainted, so PNG export keeps working

## Iteration

**Send** starts a drawing or, once one exists, sends an edit request (the model is told to preserve the canvas). **Stop** aborts the active run. **New** clears the canvas and the agent's memory.

For blank prompts the model chooses its own subject. The app does not inject subject suggestions.

The **Random** button beside the prompt asks the selected provider/model for one drawing prompt and inserts it into the prompt box.

## Gallery

The top bar has **Draw** and **Gallery** tabs; the gallery page is also reachable directly at `/gallery`. Add exported images to `public/gallery/` and commit them; when the Node server runs, `/api/gallery` scans that folder and the page displays the images. A matching sidecar JSON file with the same basename adds metadata:

```json
{
  "prompt": "Draw a dense city of glass kites at dusk.",
  "author": "karansag",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "turns": 12
}
```

Export is browser-side. The app creates PNG and JSON downloads in your browser, so files land wherever that browser is configured to save downloads. The server does not automatically write exported images into the repo. The gallery's **Submit Your Image** link opens a `mailto:` to `karan@karansag.org` with subject `agent paint image`; attach the exported files manually.
