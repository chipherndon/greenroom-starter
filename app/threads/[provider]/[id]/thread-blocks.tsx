"use client";

import { useState } from "react";
import type { ThreadBlock } from "@/lib/agent-threads";

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

const ROLE_STYLES: Record<string, string> = {
  user: "border-l-2 border-brand-500 bg-brand-50/30",
  assistant: "border-l-2 border-ink-300 bg-canvas-soft",
  system: "border-l-2 border-ink-200 bg-canvas-soft/60",
};

function TextBlock({ block }: { block: Extract<ThreadBlock, { kind: "text" }> }) {
  return (
    <div className={`px-4 py-3 rounded-r-md ${ROLE_STYLES[block.role] ?? ""}`}>
      <div className="flex items-baseline gap-3 mb-1.5">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-500 font-semibold">
          {block.role}
        </span>
        <span className="text-[10px] font-mono text-ink-400">{formatTime(block.ts)}</span>
      </div>
      <div className="text-sm text-ink-800 whitespace-pre-wrap break-words leading-relaxed">
        {block.text}
      </div>
    </div>
  );
}

function Collapsible({
  label,
  meta,
  children,
  defaultOpen = false,
  tone = "neutral",
}: {
  label: string;
  meta?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  tone?: "neutral" | "tool" | "result" | "reasoning" | "event";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toneStyles: Record<string, string> = {
    neutral: "border-ink-200/60 bg-canvas-soft/40",
    tool: "border-blue-200/60 bg-blue-50/30",
    result: "border-emerald-200/60 bg-emerald-50/20",
    reasoning: "border-purple-200/60 bg-purple-50/20",
    event: "border-ink-200/60 bg-canvas-soft/40",
  };
  return (
    <div className={`border rounded-md ${toneStyles[tone]}`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 flex items-center justify-between text-left hover:bg-ink-50/40"
      >
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-[0.1em] text-ink-500 font-semibold shrink-0">
            {label}
          </span>
          {meta && (
            <span className="text-[11px] font-mono text-ink-700 truncate">{meta}</span>
          )}
        </div>
        <span className="text-[10px] text-ink-400 shrink-0">{open ? "−" : "+"}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function ToolCallBlock({ block }: { block: Extract<ThreadBlock, { kind: "tool_call" }> }) {
  return (
    <Collapsible label={`tool: ${block.name}`} meta={block.id?.slice(0, 12)} tone="tool">
      <pre className="text-[11px] font-mono text-ink-700 whitespace-pre-wrap break-words bg-canvas-soft/60 p-2 rounded">
        {stringify(block.input)}
      </pre>
    </Collapsible>
  );
}

function ToolResultBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "tool_result" }>;
}) {
  const text = stringify(block.output);
  const preview = text.split("\n").slice(0, 1)[0]?.slice(0, 80);
  return (
    <Collapsible label="tool result" meta={preview} tone="result">
      <pre className="text-[11px] font-mono text-ink-700 whitespace-pre-wrap break-words bg-canvas-soft/60 p-2 rounded max-h-[480px] overflow-auto">
        {text}
      </pre>
    </Collapsible>
  );
}

function ReasoningBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "reasoning" }>;
}) {
  return (
    <Collapsible label="reasoning" tone="reasoning">
      <div className="text-[12px] text-ink-700 whitespace-pre-wrap break-words leading-relaxed">
        {block.text}
      </div>
    </Collapsible>
  );
}

function EventBlock({ block }: { block: Extract<ThreadBlock, { kind: "event" }> }) {
  return (
    <Collapsible label={`event: ${block.name}`} tone="event">
      <pre className="text-[11px] font-mono text-ink-700 whitespace-pre-wrap break-words bg-canvas-soft/60 p-2 rounded">
        {stringify(block.data)}
      </pre>
    </Collapsible>
  );
}

export function ThreadBlocks({ blocks }: { blocks: ThreadBlock[] }) {
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.kind === "text") return <TextBlock key={i} block={block} />;
        if (block.kind === "tool_call") return <ToolCallBlock key={i} block={block} />;
        if (block.kind === "tool_result") return <ToolResultBlock key={i} block={block} />;
        if (block.kind === "reasoning") return <ReasoningBlock key={i} block={block} />;
        return <EventBlock key={i} block={block} />;
      })}
    </div>
  );
}
