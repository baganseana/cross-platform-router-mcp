# Cross-Platform Router — Remote MCP Server (Cloudflare Workers)

Brings the router to **claude.ai web, mobile, and desktop** as a custom connector. Keys live as
Worker secrets (never in code). Exposes four tools:

| Tool | Engine | Notes |
|---|---|---|
| `research` | Google Gemini | research / synthesis. Default `gemini-2.5-flash`. |
| `ask_chatgpt` | OpenAI ChatGPT | catch-all / second opinion. Default `gpt-4o`. |
| `manus_start_task` | Manus | starts an async task, returns `task_id` + `task_url`. |
| `manus_check_task` | Manus | polls a task for its result. |

## Deploy (one-time)

```bash
cd cross-platform-router-mcp
npm install

# 1. Log into Cloudflare (opens a browser; free account is fine)
npx wrangler login

# 2. Add your API keys as encrypted secrets (paste each when prompted)
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put MANUS_API_KEY

# 3. (Optional but recommended) gate access with a shared secret
npx wrangler secret put MCP_SHARED_SECRET   # e.g. a long random string

# 4. Deploy
npx wrangler deploy
```

After deploy, your server is live at:
```
https://cross-platform-router-mcp.<your-subdomain>.workers.dev/mcp
```

## Connect it to Claude

1. Go to **claude.ai → Settings → Connectors → Add custom connector**.
2. Paste the `/mcp` URL above.
3. If you set `MCP_SHARED_SECRET`, provide it where Claude asks for the auth token/bearer.
4. Enable the connector. The four tools become available on web, mobile, and desktop.

## Security

- **Set a hard spending cap on OpenAI** (platform.openai.com → Limits). This is your primary
  protection — Gemini defaults to the free `gemini-2.5-flash`, and Manus uses prepaid credits.
- **Don't post the Worker URL publicly** (e.g. in a screenshot). If it leaks, rotate by setting a
  new `MCP_SHARED_SECRET` or renaming the Worker.
- For a stricter setup, swap the optional bearer guard for full OAuth using
  Cloudflare's `workers-oauth-provider` template.

## Local dev / test

```bash
# Put keys in a local .dev.vars file (gitignored), then:
npx wrangler dev
# Inspect with the MCP Inspector: npx @modelcontextprotocol/inspector
# Point it at http://localhost:8787/mcp
```

`.dev.vars` format:
```
GEMINI_API_KEY=...
OPENAI_API_KEY=...
MANUS_API_KEY=...
```
