# Agent Paint

MS Paint style canvas with an agent loop for OpenAI-compatible chat APIs.

The browser draws commands as they stream from the model. After each batch it can send a downscaled canvas screenshot and a compact visual summary back to the model, so the agent can continue or correct its drawing.

## Run

```bash
npm install
npm start
```

Open `http://localhost:5173`.

By default the backend probes local `llama-server` ports and uses the first healthy endpoint, currently:

```bash
http://127.0.0.1:8081/v1/chat/completions
```

Override it either in the UI or with environment variables:

```bash
LLM_PROVIDER=llama LLM_BASE_URL=http://127.0.0.1:8081 LLM_MODEL=gemma-4-26B-A4B-it-Q4_K_M.gguf npm start
```

Provider-specific API key environment variables are used when the UI key field is blank:

```bash
OPENAI_API_KEY=... LLM_PROVIDER=openai npm start
ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic npm start
```

## Providers

The app has presets for:

- **Local llama.cpp**: `http://127.0.0.1:8081/v1/chat/completions`
- **OpenAI**: `https://api.openai.com/v1/chat/completions`
- **Claude**: Anthropic's OpenAI-compatible endpoint, `https://api.anthropic.com/v1/chat/completions`
- **Custom OpenAI-compatible**: editable base URL, path, model, and optional API key

Claude support uses Anthropic's OpenAI-compatible API layer, not the native Messages API. The bridge filters provider-specific request fields so llama.cpp receives llama.cpp sampler controls, OpenAI/custom endpoints receive common OpenAI fields, and Claude receives only fields supported by the compatibility layer.

## Expected API

The server bridge expects an OpenAI-compatible streaming chat endpoint:

```http
POST /v1/chat/completions
```

with `stream: true`.

For vision feedback, use a model/server build that accepts OpenAI-style `image_url` message content. Local llama.cpp endpoints are probed with `/props`; OpenAI, Claude, and custom OpenAI-compatible endpoints are allowed to receive screenshots when the UI checkbox is enabled. When enabled, each agent turn includes a downscaled JPEG screenshot of the current canvas plus the compact text summary.

## Agent command format

The model is prompted to emit one JSON object at a time:

```json
{"type":"setColor","color":"#0f766e"}
{"type":"setBrush","size":5}
{"type":"line","x1":120,"y1":180,"x2":260,"y2":180}
{"type":"path","d":[["M",60,200],["C",100,120,180,120,220,200],["Q",260,260,300,200],["Z"]],"fill":false}
{"type":"rect","x":150,"y":120,"w":80,"h":60,"fill":false}
{"type":"batchEnd","continue":true,"note":"add details"}
```

Commands are validated on both the Node server and in the browser before drawing.

## Iteration

Use **Send** for both the first prompt and follow-up prompts. After the first drawing, follow-ups are sent as edit requests with accumulated command history so the model is told to preserve the existing canvas and add to it.

Use **New** to clear the canvas and reset agent memory.

For blank prompts, the creativity slider changes sampling only: temperature, top-p, top-k, min-p, repetition/presence/frequency penalties, XTC, dynamic temperature, and a fresh random seed. It does not inject subject suggestions.
