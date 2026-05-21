/**
 * Generate title + summary sidecars for each agent-threads/*.jsonl file.
 *
 * Usage: npx tsx scripts/summarize-threads.ts [--force]
 *
 * Sidecar location: agent-threads/<provider>/<id>.summary.json
 * Shape: { title: string; summary: string; generatedAt: string; model?: string }
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

type Provider = "claude" | "codex";

type Sidecar = {
  title: string;
  summary: string;
  generatedAt: string;
  model?: string;
};

const ROOT = path.join(process.cwd(), "agent-threads");
const FORCE = process.argv.includes("--force");
const MAX_INPUT_CHARS = 40_000;

async function readJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
}

function flattenClaudeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
        return String((part as Record<string, unknown>).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractClaudeTurns(events: unknown[]): string[] {
  const turns: string[] = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (o.type !== "user" && o.type !== "assistant") continue;
    const msg = o.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.role as string;
    const text = flattenClaudeText(msg.content).trim();
    if (!text) continue;
    turns.push(`${role.toUpperCase()}: ${text}`);
  }
  return turns;
}

function extractCodexTurns(events: unknown[]): string[] {
  const turns: string[] = [];
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const payload = (o.payload as Record<string, unknown> | undefined) ?? {};
    if (o.type === "event_msg") {
      if (payload.type === "user_message" && typeof payload.message === "string") {
        turns.push(`USER: ${payload.message}`);
      } else if (payload.type === "agent_message" && typeof payload.message === "string") {
        turns.push(`ASSISTANT: ${payload.message}`);
      }
    } else if (o.type === "response_item" && payload.type === "message") {
      const role = (payload.role as string) ?? "assistant";
      const content = payload.content;
      let text = "";
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string") {
            text += (text ? "\n" : "") + (c as Record<string, unknown>).text;
          }
        }
      } else if (typeof content === "string") {
        text = content;
      }
      if (text) turns.push(`${role.toUpperCase()}: ${text}`);
    }
  }
  return turns;
}

function buildPromptInput(turns: string[]): string {
  const joined = turns.join("\n\n");
  if (joined.length <= MAX_INPUT_CHARS) return joined;
  const half = Math.floor(MAX_INPUT_CHARS / 2);
  return (
    joined.slice(0, half) +
    `\n\n[... ${joined.length - MAX_INPUT_CHARS} chars truncated ...]\n\n` +
    joined.slice(joined.length - half)
  );
}

const SYSTEM_INSTRUCTIONS = `You will be given an excerpt of a coding-assistant session (user prompts + assistant replies, tool calls stripped).

Return ONLY a single line of JSON, no prose, no code fences:
{"title": "...", "summary": "..."}

- title: 4-8 words, sentence case, concrete (what was done). Avoid filler like "Discussion about" or "Session on".
- summary: 1-2 sentences, ~30-50 words, plain language. Describe what the user wanted and what changed/was figured out. No marketing, no fluff.

If the session is trivial / aborted / just exploration with no clear outcome, say so honestly in the summary.`;

const JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
  },
  required: ["title", "summary"],
  additionalProperties: false,
});

function runClaude(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        "--bare",
        "--append-system-prompt",
        SYSTEM_INSTRUCTIONS,
        "--json-schema",
        JSON_SCHEMA,
        "--output-format",
        "text",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

function parseModelOutput(raw: string): { title: string; summary: string } | null {
  const cleaned = raw.trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.title === "string" && typeof parsed.summary === "string") {
      return { title: parsed.title.trim(), summary: parsed.summary.trim() };
    }
  } catch {
    // fall through
  }
  return null;
}

async function summarizeOne(provider: Provider, filePath: string): Promise<void> {
  const base = path.basename(filePath, ".jsonl");
  const sidecarPath = path.join(path.dirname(filePath), `${base}.summary.json`);

  if (!FORCE) {
    try {
      await fs.access(sidecarPath);
      console.log(`  skip ${provider}/${base} (sidecar exists)`);
      return;
    } catch {
      // doesn't exist, proceed
    }
  }

  const events = await readJsonl(filePath);
  const turns =
    provider === "claude" ? extractClaudeTurns(events) : extractCodexTurns(events);

  if (turns.length === 0) {
    const sidecar: Sidecar = {
      title: "Empty session",
      summary: "No user or assistant messages were found in this transcript.",
      generatedAt: new Date().toISOString(),
    };
    await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
    console.log(`  done ${provider}/${base} (empty)`);
    return;
  }

  const input = buildPromptInput(turns);
  let raw: string;
  try {
    raw = await runClaude(input);
  } catch (err) {
    console.error(`  FAIL ${provider}/${base}: ${(err as Error).message}`);
    return;
  }

  const parsed = parseModelOutput(raw);
  if (!parsed) {
    console.error(`  FAIL ${provider}/${base}: could not parse model output`);
    console.error(`    raw: ${raw.slice(0, 300)}`);
    return;
  }

  const sidecar: Sidecar = {
    title: parsed.title,
    summary: parsed.summary,
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
  console.log(`  done ${provider}/${base}: ${parsed.title}`);
}

async function listJsonl(provider: Provider): Promise<string[]> {
  try {
    const dir = path.join(ROOT, provider);
    const entries = await fs.readdir(dir);
    return entries
      .filter((e) => e.endsWith(".jsonl"))
      .map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

async function main() {
  for (const provider of ["claude", "codex"] as const) {
    const files = await listJsonl(provider);
    console.log(`${provider}: ${files.length} file(s)`);
    for (const file of files) {
      await summarizeOne(provider, file);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
