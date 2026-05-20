/**
 * Cross-Platform Router — remote MCP server for Cloudflare Workers.
 *
 * Exposes the same routing engines as the local Claude Code skill, but reachable
 * from claude.ai (web + mobile + desktop) as a custom connector:
 *   - research        -> Google Gemini
 *   - ask_chatgpt     -> OpenAI ChatGPT
 *   - manus_start_task / manus_check_task -> Manus (async)
 *
 * Keys live as Worker secrets (set with `wrangler secret put`), never in code.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MANUS_API_KEY?: string;
  // Optional: if set, /mcp and /sse require `Authorization: Bearer <this>`.
  MCP_SHARED_SECRET?: string;
}

// ---------- Engine helpers ----------

async function callGemini(env: Env, prompt: string, model: string): Promise<string> {
  if (!env.GEMINI_API_KEY) return "[config] GEMINI_API_KEY secret not set on this Worker.";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) return `[Gemini HTTP ${res.status}] ${JSON.stringify(body)}`;
  return body?.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(body);
}

async function callOpenAI(env: Env, prompt: string, model: string): Promise<string> {
  if (!env.OPENAI_API_KEY) return "[config] OPENAI_API_KEY secret not set on this Worker.";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) return `[OpenAI HTTP ${res.status}] ${JSON.stringify(body)}`;
  return body?.choices?.[0]?.message?.content ?? JSON.stringify(body);
}

async function manusStart(env: Env, prompt: string, profile: string): Promise<string> {
  if (!env.MANUS_API_KEY) return "[config] MANUS_API_KEY secret not set on this Worker.";
  const res = await fetch("https://api.manus.ai/v2/task.create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-manus-api-key": env.MANUS_API_KEY,
    },
    body: JSON.stringify({ message: { content: prompt }, agent_profile: profile }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) return `[Manus HTTP ${res.status}] ${JSON.stringify(body)}`;
  return JSON.stringify({ task_id: body.task_id, task_url: body.task_url }, null, 2);
}

async function manusCheck(env: Env, taskId: string): Promise<string> {
  if (!env.MANUS_API_KEY) return "[config] MANUS_API_KEY secret not set on this Worker.";
  const url = `https://api.manus.ai/v2/task.listMessages?task_id=${encodeURIComponent(
    taskId,
  )}&order=asc&limit=100&verbose=false`;
  const res = await fetch(url, { headers: { "x-manus-api-key": env.MANUS_API_KEY } });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) return `[Manus HTTP ${res.status}] ${JSON.stringify(body)}`;

  const events: any[] = body?.messages ?? [];
  const assistant: string[] = [];
  let status: string | null = null;
  let errorText: string | null = null;
  let waiting: string | null = null;
  for (const ev of events) {
    if (ev.type === "assistant_message" && ev.assistant_message?.content) {
      assistant.push(ev.assistant_message.content);
    } else if (ev.type === "error_message") {
      errorText = ev.error_message?.content ?? "unknown error";
    } else if (ev.type === "status_update") {
      status = ev.status_update?.agent_status ?? status;
      if (status === "waiting") {
        waiting = ev.status_update?.status_detail?.waiting_description ?? "needs confirmation";
      }
    }
  }
  if (status === "stopped") return assistant.join("\n\n") || "[Manus finished with no text output]";
  if (status === "error" || errorText) return `[Manus error] ${errorText ?? "agent error state"}`;
  if (status === "waiting") return `[Manus paused — needs confirmation] ${waiting}. Open the task to continue.`;
  return `[Manus still running] status=${status ?? "starting"}. Call manus_check_task again in ~15s.`;
}

// ---------- MCP server (Durable Object) ----------

export class CrossPlatformRouterMCP extends McpAgent<Env> {
  server = new McpServer({ name: "cross-platform-router", version: "1.0.0" });

  async init() {
    const env = this.env;

    this.server.tool(
      "research",
      "Deep research, multi-source synthesis, or summarizing long documents — routed to Google Gemini. Use for 'look into', 'investigate', 'compare', or research-style questions.",
      {
        prompt: z.string().describe("The research question or task."),
        model: z
          .string()
          .optional()
          .describe("Gemini model. Default gemini-2.5-flash (free tier). Use gemini-2.5-pro with billing."),
      },
      async ({ prompt, model }) => ({
        content: [{ type: "text", text: await callGemini(env, prompt, model ?? "gemini-2.5-flash") }],
      }),
    );

    this.server.tool(
      "ask_chatgpt",
      "General catch-all or a second opinion from a different model — routed to OpenAI ChatGPT. Use when the user wants ChatGPT's take or a contrasting perspective.",
      {
        prompt: z.string().describe("The prompt to send to ChatGPT."),
        model: z.string().optional().describe("OpenAI model. Default gpt-4o."),
      },
      async ({ prompt, model }) => ({
        content: [{ type: "text", text: await callOpenAI(env, prompt, model ?? "gpt-4o") }],
      }),
    );

    this.server.tool(
      "manus_start_task",
      "Start an autonomous, multi-step 'go do this' task on Manus. Returns a task_id and a live task_url immediately. Manus runs async — poll with manus_check_task to get the result.",
      {
        prompt: z.string().describe("The task objective, with success criteria and deliverable format."),
        profile: z
          .string()
          .optional()
          .describe("manus-1.6 (default), manus-1.6-lite (fast/cheap), or manus-1.6-max (best)."),
      },
      async ({ prompt, profile }) => ({
        content: [{ type: "text", text: await manusStart(env, prompt, profile ?? "manus-1.6") }],
      }),
    );

    this.server.tool(
      "manus_check_task",
      "Check the status/result of a Manus task started with manus_start_task. Returns the agent's output when finished, or a 'still running' message to poll again.",
      { task_id: z.string().describe("The task_id returned by manus_start_task.") },
      async ({ task_id }) => ({
        content: [{ type: "text", text: await manusCheck(env, task_id) }],
      }),
    );
  }
}

// ---------- HTTP entrypoint ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    // Lockdown: if MCP_SHARED_SECRET is set, it must be the first path segment.
    // The full secret endpoint is therefore: https://<worker>/<SECRET>/mcp
    // This works with any MCP client (no custom auth header needed) — the URL is the credential.
    if (env.MCP_SHARED_SECRET) {
      const prefix = `/${env.MCP_SHARED_SECRET}`;
      if (path === prefix || path.startsWith(prefix + "/")) {
        path = path.slice(prefix.length) || "/";
      } else {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    if (path === "/") {
      return new Response("Cross-Platform Router MCP is running. Connect via the /mcp endpoint.", {
        status: 200,
      });
    }

    // Rewrite the request URL to the stripped path so the MCP transport routing matches.
    const innerUrl = new URL(request.url);
    innerUrl.pathname = path;
    const innerReq = new Request(innerUrl.toString(), request);

    if (path === "/sse" || path === "/sse/message") {
      return CrossPlatformRouterMCP.serveSSE("/sse").fetch(innerReq, env, ctx);
    }
    if (path === "/mcp") {
      return CrossPlatformRouterMCP.serve("/mcp").fetch(innerReq, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
