// bb-plugin-side-board — frontend.
//
// Two surfaces over one board:
//   - a thread side-panel tab rendering the board as Markdown (board.ts
//     renderMarkdown): Questions, Bugs, Todos, open first
//   - a thread-header badge with the open count, which opens the panel by
//     itself when a new item lands
// The panel is read-only by design: the user answers in chat by id ("Q3
// clerk") and the agent closes the item.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { definePluginApp, Markdown, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import { renderMarkdown } from "./board";
import type { Board, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Must match the threadPanelAction id below — openThreadPanel names it. */
const PANEL_ACTION_ID = "board";
const PANEL_TITLE = "Side board";
/** Must match BOARD_CHANGED in server.ts (a type-only import cannot carry it). */
const BOARD_CHANGED = "board-changed";

/** One thread's board, refetched when the server announces a change to it. */
function useBoard(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("board_get", { threadId }).then(
      (result) => {
        setBoard(result);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc, threadId]);

  useEffect(() => {
    // A split layout mounts one of these per visible thread: everything is
    // keyed by threadId and nothing lives at module scope.
    setBoard(null);
    refetch();
  }, [refetch]);

  useRealtime(BOARD_CHANGED, (payload) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    if (changed === threadId) refetch();
  });

  return { board, error };
}

function formatTime(iso: string | null): string | null {
  if (iso === null) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function BoardPanel({ threadId }: PluginThreadPanelProps) {
  const { board, error } = useBoard(threadId);
  const markdown = useMemo(
    () => (board === null ? "" : renderMarkdown(board, formatTime(board.touchedAt))),
    [board],
  );
  if (error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (board === null) return <p className="text-sm text-muted-foreground">Loading the board…</p>;
  if (board.items.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
      >
        Nothing on the board yet.
        <br />
        Questions, bugs and todos the agent raises appear here.
      </div>
    );
  }
  const openQuestions = board.items.some((item) => item.kind === "question" && item.status === "open");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Markdown content={markdown} />
      {openQuestions ? (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          Answer in chat by id, e.g. <code>Q2 soft, Q3 clerk</code>, or <code>go</code> to take every
          recommendation.
        </p>
      ) : null}
    </div>
  );
}

/** Always mounted while a thread is open, which lets it open the panel. */
function BoardBadge({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { board } = useBoard(threadId);
  const navigate = useBbNavigate();
  const openItems = board?.items.filter((item) => item.status === "open") ?? [];
  const open = openItems.length;
  const blocking = openItems.some((item) => item.blocking);
  const newest = board?.items.at(-1)?.id ?? null;

  const openPanel = useCallback(() => {
    navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: PANEL_TITLE });
  }, [navigate]);

  // Open the panel once per newly added item, so closing the tab sticks until
  // the agent records something new.
  const seenRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    seenRef.current = undefined;
  }, [threadId]);
  useEffect(() => {
    if (board === null) return;
    if (seenRef.current === undefined) {
      // First load of this thread: remember what is there, do not pop open.
      seenRef.current = newest;
      return;
    }
    if (newest === seenRef.current) return;
    seenRef.current = newest;
    if (newest !== null) openPanel();
  }, [board, newest, openPanel]);

  if (board === null || open === 0) return null;
  const label = `${open} open on the side board`;
  return (
    <Button
      variant="ghost"
      size={isCompactViewport ? "icon" : "sm"}
      onClick={openPanel}
      aria-label={label}
      className={cn(blocking && "text-destructive")}
    >
      <Icon name="ListTodo" className="size-4" />
      {isCompactViewport ? null : <span className="tabular-nums">{open}</span>}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: PANEL_TITLE,
    icon: "ListTodo",
    component: BoardPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "board-badge",
    title: PANEL_TITLE,
    component: BoardBadge,
  });
});
