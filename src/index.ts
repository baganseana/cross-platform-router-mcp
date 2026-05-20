/**
 * Cross-Platform Router — remote MCP server for Cloudflare Workers.
 *
 * Routes tasks to Gemini / ChatGPT / Manus, and gives them a SHARED MEMORY so all
 * engines (plus Claude) stay on the same page. Memory lives in Workers KV, is injected
 * into every engine call, can be read/updated via tools, synced via /admin/memory, and
 * is tidied daily by a cron-triggered reconciliation pass.
 *
 * Tools: research (Gemini), ask_chatgpt (OpenAI), manus_start_task, manus_check_task,
 *        get_memory, remember.
 * Keys + secret live as Worker secrets (never in code).
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  MEMORY: KVNamespace;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MANUS_API_KEY?: string;
  MCP_SHARED_SECRET?: string;
}

// ---------- Shared memory ----------

const MEM_KEY = "memory:doc";
const MEM_PREV = "memory:doc:prev";
const MEM_HEADER =
  "[SHARED MEMORY — persistent context that Claude, Gemini, ChatGPT and Manus all share. " +
  "Treat it as background truth. Apply it; do not repeat it back unless asked.]";
const MEM_FOOTER = "[END SHARED MEMORY]";

async function loadMemory(env: Env): Promise<string> {
  if (!env.MEMORY) return "";
  return (await env.MEMORY.get(MEM_KEY)) ?? "";
}

async function saveMemory(env: Env, text: string): Promise<void> {
  const prev = await env.MEMORY.get(MEM_KEY);
  if (prev) await env.MEMORY.put(MEM_PREV, prev); // keep one backup for recovery
  await env.MEMORY.put(MEM_KEY, text);
}

function wrapWithMemory(mem: string, prompt: string): string {
  if (!mem.trim()) return prompt;
  return `${MEM_HEADER}\n${mem}\n${MEM_FOOTER}\n\n${prompt}`;
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
    headers: { "Content-Type": "application/json", "x-manus-api-key": env.MANUS_API_KEY },
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

// ---------- Cron: tidy/reconcile the shared memory ----------

async function reconcileMemory(env: Env): Promise<void> {
  const mem = await loadMemory(env);
  if (!mem.trim() || !env.GEMINI_API_KEY) return;
  const instruction =
    "You are tidying a SHARED MEMORY document used by multiple AI assistants. " +
    "Return ONLY the cleaned markdown — no preamble, no code fences. Rules: keep the section " +
    "headers (## About / Business, ## Preferences & Voice, ## Active Projects & Decisions, " +
    "## Glossary & People); merge duplicate facts; if two facts contradict, keep the most " +
    "recent (later '(added ...)' date) and drop the older; remove empty placeholder lines " +
    "like '<add ...>'; do NOT invent or infer new facts. Current memory:\n\n" +
    mem;
  let cleaned = await callGemini(env, instruction, "gemini-2.5-flash");
  if (!cleaned || cleaned.startsWith("[Gemini") || cleaned.length < 20) return; // skip on error
  cleaned = cleaned.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/i, "").trim();
  await saveMemory(env, cleaned);
}

// ---------- MCP server (Durable Object) ----------

export class CrossPlatformRouterMCP extends McpAgent<Env> {
  server = new McpServer({ name: "cross-platform-router", version: "1.1.0" });

  async init() {
    const env = this.env;

    this.server.tool(
      "research",
      "Deep research, multi-source synthesis, or summarizing long documents — routed to Google Gemini. Shared memory is applied automatically.",
      {
        prompt: z.string().describe("The research question or task."),
        model: z.string().optional().describe("Gemini model. Default gemini-2.5-flash."),
      },
      async ({ prompt, model }) => {
        const mem = await loadMemory(env);
        const text = await callGemini(env, wrapWithMemory(mem, prompt), model ?? "gemini-2.5-flash");
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.tool(
      "ask_chatgpt",
      "General catch-all or a second opinion from a different model — routed to OpenAI ChatGPT. Shared memory is applied automatically.",
      {
        prompt: z.string().describe("The prompt to send to ChatGPT."),
        model: z.string().optional().describe("OpenAI model. Default gpt-4o."),
      },
      async ({ prompt, model }) => {
        const mem = await loadMemory(env);
        const text = await callOpenAI(env, wrapWithMemory(mem, prompt), model ?? "gpt-4o");
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.tool(
      "manus_start_task",
      "Start an autonomous, multi-step 'go do this' task on Manus. Returns task_id + task_url immediately; poll with manus_check_task. Shared memory is applied automatically.",
      {
        prompt: z.string().describe("The task objective, with success criteria and deliverable format."),
        profile: z.string().optional().describe("manus-1.6 (default), manus-1.6-lite, or manus-1.6-max."),
      },
      async ({ prompt, profile }) => {
        const mem = await loadMemory(env);
        const text = await manusStart(env, wrapWithMemory(mem, prompt), profile ?? "manus-1.6");
        return { content: [{ type: "text", text }] };
      },
    );

    this.server.tool(
      "manus_check_task",
      "Check the status/result of a Manus task started with manus_start_task.",
      { task_id: z.string().describe("The task_id returned by manus_start_task.") },
      async ({ task_id }) => ({ content: [{ type: "text", text: await manusCheck(env, task_id) }] }),
    );

    this.server.tool(
      "get_memory",
      "Return the current shared memory that Claude, Gemini, ChatGPT and Manus all use.",
      {},
      async () => ({ content: [{ type: "text", text: (await loadMemory(env)) || "(shared memory is empty)" }] }),
    );

    this.server.tool(
      "remember",
      "Add a durable fact/preference to shared memory so ALL engines know it going forward. Use for stable facts, not one-off details.",
      { fact: z.string().describe("A concise fact, preference, or decision to remember.") },
      async ({ fact }) => {
        const cur = await loadMemory(env);
        const stamp = new Date().toISOString().slice(0, 10);
        const updated = `${cur ? cur + "\n" : ""}- ${fact} _(added ${stamp})_`;
        await saveMemory(env, updated);
        return { content: [{ type: "text", text: `Saved to shared memory: ${fact}` }] };
      },
    );
  }
}

// ---------- HTTP entrypoint + cron ----------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    let path = url.pathname;

    // Lockdown: if MCP_SHARED_SECRET is set, it must be the first path segment.
    // Full secret endpoint: https://<worker>/<SECRET>/mcp
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

    // Memory sync endpoint (push/pull). Requires MCP_SHARED_SECRET to be configured.
    if (path === "/admin/memory") {
      if (!env.MCP_SHARED_SECRET) return new Response("admin disabled (set MCP_SHARED_SECRET)", { status: 403 });
      if (request.method === "GET") {
        return new Response(await loadMemory(env), { status: 200, headers: { "content-type": "text/markdown" } });
      }
      if (request.method === "PUT") {
        await saveMemory(env, await request.text());
        return new Response("ok", { status: 200 });
      }
      return new Response("method not allowed", { status: 405 });
    }

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

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcileMemory(env));
  },
};
