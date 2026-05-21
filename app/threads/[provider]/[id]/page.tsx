import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { loadThread, type Provider, type ThreadBlock } from "@/lib/agent-threads";
import { ThreadBlocks } from "./thread-blocks";

export const metadata: Metadata = { title: "Thread" };

function formatTime(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ provider: string; id: string }>;
}) {
  const { provider, id } = await params;
  if (provider !== "claude" && provider !== "codex") notFound();
  const thread = await loadThread(provider as Provider, id);
  if (!thread) notFound();

  return (
    <div className="px-12 py-10 max-w-4xl">
      <div className="mb-6">
        <Link
          href="/threads"
          className="text-[11px] uppercase tracking-[0.1em] text-ink-400 hover:text-ink-600"
        >
          ← All threads
        </Link>
      </div>

      <h1 className="font-display text-2xl text-ink-900 mb-1">
        {thread.title ?? thread.firstUserText?.slice(0, 80) ?? "Untitled session"}
      </h1>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-500 mb-1">
        <span className="uppercase tracking-[0.1em]">{thread.provider}</span>
        <span className="font-mono">{thread.id}</span>
        <span>{formatTime(thread.startedAt)}</span>
        <span>· {thread.messageCount} msgs</span>
        <span>· {thread.toolCallCount} tool calls</span>
      </div>
      {thread.cwd && (
        <div className="text-[11px] font-mono text-ink-400 mb-8 truncate">
          {thread.cwd}
        </div>
      )}

      <ThreadBlocks blocks={thread.blocks as ThreadBlock[]} />
    </div>
  );
}
