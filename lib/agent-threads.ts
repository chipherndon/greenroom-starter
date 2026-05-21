import fs from "node:fs/promises";
import path from "node:path";

export type Provider = "claude" | "codex";

export type ThreadBlock =
  | { kind: "text"; role: "user" | "assistant" | "system"; text: string; ts?: string }
  | { kind: "tool_call"; name: string; input: unknown; id?: string; ts?: string }
  | { kind: "tool_result"; name?: string; output: unknown; id?: string; ts?: string }
  | { kind: "reasoning"; text: string; ts?: string }
  | { kind: "event"; name: string; data?: unknown; ts?: string };

export type ThreadSummary = {
  provider: Provider;
  id: string;
  file: string;
  title: string | null;
  summary: string | null;
  firstUserText: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  messageCount: number;
  toolCallCount: number;
};

export type Thread = ThreadSummary & {
  blocks: ThreadBlock[];
};

const ROOT = path.join(process.cwd(), "agent-threads");

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const out: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed
    }
  }
  return out;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function flattenClaudeContent(content: unknown): {
  text: string;
  blocks: ThreadBlock[];
} {
  const blocks: ThreadBlock[] = [];
  let text = "";
  if (!Array.isArray(content)) return { text, blocks };
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as Record<string, unknown>;
    const t = part.type;
    if (t === "text" && typeof part.text === "string") {
      text += (text ? "\n" : "") + part.text;
    } else if (t === "tool_use") {
      blocks.push({
        kind: "tool_call",
        name: asString(part.name) ?? "tool",
        input: part.input,
        id: asString(part.id) ?? undefined,
      });
    } else if (t === "tool_result") {
      blocks.push({
        kind: "tool_result",
        output: part.content ?? part,
        id: asString(part.tool_use_id) ?? undefined,
      });
    } else if (t === "image") {
      blocks.push({ kind: "event", name: "image", data: part });
    }
  }
  return { text, blocks };
}

function parseClaude(events: unknown[]): Omit<Thread, "provider" | "file"> {
  const blocks: ThreadBlock[] = [];
  let title: string | null = null;
  let firstUserText: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;
  let messageCount = 0;
  let toolCallCount = 0;
  let id = "";

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    const e = evt as Record<string, unknown>;
    const ts = asString(e.timestamp) ?? undefined;
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    if (!id && typeof e.sessionId === "string") id = e.sessionId;
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd;

    const top = e.type;
    if (top === "ai-title" && typeof (e.title ?? e.text) === "string") {
      title = asString(e.title ?? e.text);
    }
    if (top === "user" || top === "assistant") {
      const message = e.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const role = (message.role as "user" | "assistant") ?? top;
      const content = message.content;
      if (typeof content === "string") {
        blocks.push({ kind: "text", role, text: content, ts });
        if (role === "user" && !firstUserText) firstUserText = content;
        messageCount++;
        continue;
      }
      const { text, blocks: extra } = flattenClaudeContent(content);
      if (text) {
        blocks.push({ kind: "text", role, text, ts });
        if (role === "user" && !firstUserText) firstUserText = text;
        messageCount++;
      }
      for (const b of extra) {
        if (b.kind === "tool_call") toolCallCount++;
        blocks.push({ ...b, ts });
      }
    } else if (top === "system") {
      const text =
        asString((e.message as Record<string, unknown> | undefined)?.content) ??
        asString(e.content) ??
        asString(e.text);
      if (text) blocks.push({ kind: "text", role: "system", text, ts });
    }
  }

  return {
    id,
    title,
    summary: null,
    firstUserText,
    startedAt,
    endedAt,
    cwd,
    messageCount,
    toolCallCount,
    blocks,
  };
}

function parseCodex(events: unknown[]): Omit<Thread, "provider" | "file"> {
  const blocks: ThreadBlock[] = [];
  let title: string | null = null;
  let firstUserText: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let cwd: string | null = null;
  let messageCount = 0;
  let toolCallCount = 0;
  let id = "";

  for (const evt of events) {
    if (!evt || typeof evt !== "object") continue;
    const e = evt as Record<string, unknown>;
    const ts = asString(e.timestamp) ?? undefined;
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    const top = e.type;
    const payload = (e.payload as Record<string, unknown> | undefined) ?? {};

    if (top === "session_meta") {
      if (!id && typeof payload.id === "string") id = payload.id;
      if (!cwd && typeof payload.cwd === "string") cwd = payload.cwd;
      continue;
    }

    if (top === "event_msg") {
      const pt = payload.type;
      if (pt === "user_message" && typeof payload.message === "string") {
        blocks.push({ kind: "text", role: "user", text: payload.message, ts });
        if (!firstUserText) firstUserText = payload.message;
        messageCount++;
      } else if (pt === "agent_message" && typeof payload.message === "string") {
        blocks.push({ kind: "text", role: "assistant", text: payload.message, ts });
        messageCount++;
      } else if (pt === "mcp_tool_call_end" || pt === "patch_apply_end") {
        blocks.push({ kind: "event", name: pt, data: payload, ts });
      } else if (pt === "task_started" || pt === "task_complete" || pt === "turn_aborted") {
        blocks.push({ kind: "event", name: pt, data: payload, ts });
      }
      continue;
    }

    if (top === "response_item") {
      const pt = payload.type;
      if (pt === "message") {
        const role = (payload.role as "user" | "assistant" | "system") ?? "assistant";
        const content = payload.content;
        let text = "";
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c && typeof c === "object") {
              const cc = c as Record<string, unknown>;
              if (typeof cc.text === "string") text += (text ? "\n" : "") + cc.text;
            }
          }
        } else if (typeof content === "string") {
          text = content;
        }
        if (text) {
          blocks.push({ kind: "text", role, text, ts });
          if (role === "user" && !firstUserText) firstUserText = text;
          messageCount++;
        }
      } else if (pt === "function_call" || pt === "custom_tool_call" || pt === "tool_search_call") {
        let input: unknown = payload.arguments ?? payload.input ?? payload;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            // leave as string
          }
        }
        blocks.push({
          kind: "tool_call",
          name: asString(payload.name) ?? String(pt),
          input,
          id: asString(payload.call_id) ?? undefined,
          ts,
        });
        toolCallCount++;
      } else if (
        pt === "function_call_output" ||
        pt === "custom_tool_call_output" ||
        pt === "tool_search_output"
      ) {
        blocks.push({
          kind: "tool_result",
          output: payload.output ?? payload,
          id: asString(payload.call_id) ?? undefined,
          ts,
        });
      } else if (pt === "reasoning") {
        const summary = payload.summary;
        let text = "";
        if (Array.isArray(summary)) {
          for (const s of summary) {
            if (s && typeof s === "object") {
              const ss = s as Record<string, unknown>;
              if (typeof ss.text === "string") text += (text ? "\n" : "") + ss.text;
            }
          }
        } else if (typeof payload.content === "string") {
          text = payload.content;
        }
        if (text) blocks.push({ kind: "reasoning", text, ts });
      }
      continue;
    }
  }

  return {
    id,
    title,
    summary: null,
    firstUserText,
    startedAt,
    endedAt,
    cwd,
    messageCount,
    toolCallCount,
    blocks,
  };
}

async function listProvider(provider: Provider): Promise<string[]> {
  try {
    const dir = path.join(ROOT, provider);
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith(".jsonl")).map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

function fileId(filePath: string): string {
  const base = path.basename(filePath, ".jsonl");
  return base;
}

async function readSidecar(
  filePath: string,
): Promise<{ title: string | null; summary: string | null }> {
  const sidecarPath = filePath.replace(/\.jsonl$/, ".summary.json");
  try {
    const raw = await fs.readFile(sidecarPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      title: typeof parsed.title === "string" ? parsed.title : null,
      summary: typeof parsed.summary === "string" ? parsed.summary : null,
    };
  } catch {
    return { title: null, summary: null };
  }
}

export async function loadThread(provider: Provider, id: string): Promise<Thread | null> {
  const files = await listProvider(provider);
  const match = files.find((f) => fileId(f) === id);
  if (!match) return null;
  const events = await readJsonl(match);
  const parsed = provider === "claude" ? parseClaude(events) : parseCodex(events);
  const sidecar = await readSidecar(match);
  return {
    provider,
    file: match,
    ...parsed,
    title: sidecar.title ?? parsed.title,
    summary: sidecar.summary,
    id: parsed.id || id,
  };
}

export async function listAllThreads(): Promise<ThreadSummary[]> {
  const out: ThreadSummary[] = [];
  for (const provider of ["claude", "codex"] as const) {
    const files = await listProvider(provider);
    for (const file of files) {
      const events = await readJsonl(file);
      const parsed = provider === "claude" ? parseClaude(events) : parseCodex(events);
      const sidecar = await readSidecar(file);
      const { blocks: _blocks, ...rest } = parsed;
      out.push({
        provider,
        file,
        ...rest,
        title: sidecar.title ?? parsed.title,
        summary: sidecar.summary,
        id: parsed.id || fileId(file),
      });
    }
  }
  out.sort((a, b) => {
    const at = a.startedAt ?? "";
    const bt = b.startedAt ?? "";
    return at.localeCompare(bt);
  });
  return out;
}
