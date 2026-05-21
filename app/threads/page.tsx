import Link from "next/link";
import type { Metadata } from "next";
import { listAllThreads } from "@/lib/agent-threads";

export const metadata: Metadata = { title: "AI session log" };

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function truncate(s: string | null, n = 120): string {
  if (!s) return "—";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const PROVIDER_TAG_STYLES: Record<string, string> = {
  claude: "bg-brand-100 text-brand-800",
  codex: "bg-ink-100 text-ink-700",
};

export default async function ThreadsPage() {
  const threads = await listAllThreads();

  return (
    <div className="px-12 py-10 max-w-5xl">
      <div className="text-[10px] uppercase tracking-[0.1em] text-ink-400 mb-2">
        For reviewer
      </div>
      <h1 className="font-display text-3xl text-ink-900 mb-3">AI session log</h1>
      <div className="text-sm text-ink-600 leading-relaxed mb-8 max-w-2xl space-y-2.5">
        <p>
          Every Claude Code and Codex session I ran while working on this case
          study is archived here ({threads.length} total). Each entry links to
          the full raw transcriptL prompts, assistant replies, tool calls, and file edits.
        </p>
        <p>
          The titles and one-line descriptions below were generated using claude -p
          from each transcript (script:{" "}
          <code className="text-[12px] font-mono text-ink-700">
            scripts/summarize-threads.ts
          </code>
          ). I&apos;m including this so my AI usage is fully transparent: what I
          asked, what was produced, and where I steered.
        </p>
      </div>

      <ul className="space-y-1.5">
        {threads.map((t) => (
          <li
            key={`${t.provider}-${t.id}`}
            className="border border-ink-200/60 rounded-md hover:border-ink-300 transition-colors"
          >
            <Link
              href={`/threads/${t.provider}/${t.id}`}
              className="block px-4 py-3"
            >
              <div className="flex items-baseline justify-between gap-4">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span
                    className={`shrink-0 inline-block text-[9.5px] font-semibold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded ${
                      PROVIDER_TAG_STYLES[t.provider] ?? ""
                    }`}
                  >
                    {PROVIDER_LABEL[t.provider] ?? t.provider}
                  </span>
                  <div className="text-sm text-ink-900 font-medium truncate">
                    {truncate(t.title ?? t.firstUserText, 90)}
                  </div>
                </div>
                <div className="text-[11px] text-ink-400 shrink-0 font-mono">
                  {formatTime(t.startedAt)}
                </div>
              </div>
              {t.summary && (
                <div className="mt-1.5 text-[12px] text-ink-600 leading-relaxed">
                  {t.summary}
                </div>
              )}
              <div className="mt-1.5 text-[11px] text-ink-500 flex gap-3">
                <span>{t.messageCount} msgs</span>
                <span>{t.toolCallCount} tool calls</span>
                <span className="font-mono truncate">{t.id.slice(0, 8)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
