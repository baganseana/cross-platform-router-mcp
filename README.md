# Cross-Platform Router — Remote MCP Server (Cloudflare Workers)

Brings the [Cross-Platform Router](https://github.com/baganseana/cross-platform-router) to
**claude.ai web, mobile, and desktop** as a custom connector. It routes tasks to Gemini, ChatGPT,
and Manus. Keys live as encrypted Worker secrets (never in code). Exposes four tools:

| Tool | Engine | Notes |
|---|---|---|
| `research` | Google Gemini | research / synthesis. Default `gemini-2.5-flash`. |
| `ask_chatgpt` | OpenAI ChatGPT | catch-all / second opinion. Default `gpt-4o`. |
| `manus_start_task` | Manus | starts an async task, returns `task_id` + `task_url`. |
| `manus_check_task` | Manus | polls a task for its result. |

---

## ⚠️ Deploy your OWN — do not reuse anyone else's URL

This server holds **whoever deployed it's** API keys. If you connect to someone else's Worker URL,
**you spend their API budget** (and they can see your prompts). There is no shared/public instance.

**Everyone runs their own copy** with their own Cloudflare account and their own API keys. It's free
(Cloudflare Workers free tier) and takes ~5 minutes. Follow the steps below.

---

## Deploy (one-time, ~5 min)

```bash
git clone <this-repo-url>
cd cross-platform-router-mcp
npm install

# 1. Log into YOUR Cloudflare account (opens a browser; free account is fine)
npx wrangler login

# 2. Deploy once to create the Worker
npx wrangler deploy

# 3. Add YOUR OWN API keys as encrypted secrets (paste each when prompted)
npx wrangler secret put GEMINI_API_KEY     # aistudio.google.com/apikey
npx wrangler secret put OPENAI_API_KEY      # platform.openai.com/api-keys
npx wrangler secret put MANUS_API_KEY       # open.manus.ai (Settings → API)

# 4. Lock it down with a URL secret (STRONGLY recommended)
openssl rand -hex 24                         # copy the output
npx wrangler secret put MCP_SHARED_SECRET    # paste it when prompted

# 5. Redeploy so the secret takes effect
npx wrangler deploy
```

### Your connector URL

- **Without** `MCP_SHARED_SECRET`: `https://cross-platform-router-mcp.<your-subdomain>.workers.dev/mcp`
- **With** `MCP_SHARED_SECRET` (recommended): the secret becomes part of the path —
  `https://cross-platform-router-mcp.<your-subdomain>.workers.dev/<YOUR_SECRET>/mcp`

The full secret URL **is** the credential. Without it, the endpoint returns `401 Unauthorized`.

## Connect it to Claude

1. **claude.ai → Settings → Connectors → Add custom connector**
2. Paste your connector URL from above (the `/<secret>/mcp` form if you set one)
3. Auth: **None** (the URL itself carries the secret)
4. Enable it. The four tools appear on web, mobile, and desktop.

## Security

- **Set a hard spending cap on OpenAI** (platform.openai.com → Limits). Primary protection —
  Gemini defaults to free `gemini-2.5-flash`, Manus uses prepaid credits.
- **Always set `MCP_SHARED_SECRET`** and treat the full URL as a password. Don't put it in
  screenshots, posts, or shared docs.
- **If a URL leaks:** rotate it — `npx wrangler secret put MCP_SHARED_SECRET` with a new value, then
  `npx wrangler deploy`. The old URL stops working immediately.
- For org-grade auth, swap the URL secret for full OAuth via Cloudflare's `workers-oauth-provider`.

## Local dev / test

```bash
# Put YOUR keys in a local .dev.vars file (gitignored), then:
npx wrangler dev
# Inspect with: npx @modelcontextprotocol/inspector  → point at http://localhost:8787/mcp
```

`.dev.vars` format (never commit this file):
```
GEMINI_API_KEY=...
OPENAI_API_KEY=...
MANUS_API_KEY=...
MCP_SHARED_SECRET=...
```
