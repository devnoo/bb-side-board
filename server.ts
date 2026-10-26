// bb-plugin-side-board — backend.
//
// One board per thread in bb.storage.kv. Four surfaces share it:
//   - agent tools board_add / board_close / board_list, so agents record
//     questions, bugs and todos as structured items, not chat prose
//   - instructions contributed to every thread, telling agents when to call them
//   - a thread.idle safety net that nudges an agent whose reply raised or
//     finished something without touching the board
//   - RPC + realtime for the side panel in app.tsx
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  addItems,
  boardSchema,
  closeItems,
  closeSchema,
  counts,
  detectMiss,
  emptyBoard,
  formatBoard,
  formatItem,
  newItemSchema,
  nudgeText,
  type Board,
} from "./board";

export type { Board, Item } from "./board";

export const rpcContract = defineRpcContract({
  board_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: boardSchema,
  },
});

/** Realtime channel app.tsx listens on; the payload names the thread. */
export const BOARD_CHANGED = "board-changed";

const RULES = `## Side board

This thread has a side board: a panel beside the chat listing the open questions, bugs and todos of this conversation. Keep it current with these tools. It is the user's overview, so it must never miss an item.

- **Question** you need the user to answer or decide → \`board_add\` kind "question", in the same turn you ask it. Give a 1-4 word \`label\`, exactly one \`recommendation\`, up to 3 \`alternatives\` with their trade-off, and \`blocking: true\` only when you cannot continue without it. When it is not blocking, proceed on your recommendation and say so.
- **Bug** you noticed but were not asked to fix → \`board_add\` kind "bug" with \`location\` (file:line or a command). Record it; do not fix it mid-task.
- **Todo**: work you deferred, or a later step for the user → \`board_add\` kind "todo" with a concrete \`estimate\`.
- Add several items in one \`board_add\` call.
- **Close** an item with \`board_close\` in the same turn it is answered, fixed, done or dropped. When the user answers "Q3 clerk", close Q3 with that answer. When the user says "go", close every open question with its recommendation.
- In chat, refer to items only by id: one line per new open question, e.g. \`Q3 · Clerk or Lucia? (recommend Clerk)\`, then: Answer by id, e.g. \`Q3 lucia\`, or \`go\` to take all recommendations. Do not restate bugs and todos in prose; the panel shows them.
- \`board_list\` shows the current board when you need ids.`;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    nudge: {
      type: "boolean",
      label: "Nudge agents that forget the board",
      description:
        "After a reply that asks a question, mentions a bug or deferred work, or finishes open work without updating the board, send the agent one short reminder.",
      default: true,
    },
  });
  const { nudge } = await settings.get();

  const key = (threadId: string) => `board:${threadId}`;

  async function readBoard(threadId: string): Promise<Board> {
    const stored = await bb.storage.kv.get<unknown>(key(threadId));
    const parsed = boardSchema.safeParse(stored);
    return parsed.success ? parsed.data : emptyBoard();
  }

  // Writes to one thread's board are serialized: two tool calls in one turn
  // must not both read the same counters and hand out the same id.
  const queues = new Map<string, Promise<unknown>>();
  function update<T>(threadId: string, change: (board: Board) => { board: Board; result: T }): Promise<T> {
    const previous = queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const { board, result } = change(await readBoard(threadId));
      await bb.storage.kv.set(key(threadId), board);
      bb.realtime.publish(BOARD_CHANGED, { threadId });
      return result;
    });
    const settled = next.catch(() => undefined);
    queues.set(threadId, settled);
    void settled.then(() => {
      if (queues.get(threadId) === settled) queues.delete(threadId);
    });
    return next;
  }

  bb.rpc.register(rpcContract, {
    board_get: ({ threadId }) => readBoard(threadId),
  });

  bb.agents.registerTool({
    name: "board_add",
    description:
      "Add questions for the user, bugs you noticed, or deferred todos to this thread's side board. Returns the ids (Q1, B1, T1) to use in chat.",
    presentation: { label: { pending: "Adding to the side board", completed: "Added to the side board" } },
    parameters: z.object({ items: z.array(newItemSchema).min(1).max(10) }),
    async execute({ items }, { threadId }) {
      const added = await update(threadId, (board) => {
        const { board: next, added } = addItems(board, items, new Date().toISOString());
        return { board: next, result: added };
      });
      return added.map(formatItem).join("\n");
    },
  });

  bb.agents.registerTool({
    name: "board_close",
    description:
      "Close side-board items that were answered, fixed, done or dropped, each with a one-line resolution.",
    presentation: { label: { pending: "Closing side-board items", completed: "Closed side-board items" } },
    parameters: z.object({ items: z.array(closeSchema).min(1).max(20) }),
    async execute({ items }, { threadId }) {
      const { closed, missing } = await update(threadId, (board) => {
        const { board: next, ...result } = closeItems(board, items, new Date().toISOString());
        return { board: next, result };
      });
      const lines = closed.map(formatItem);
      if (missing.length > 0) lines.push(`Not on the board: ${missing.join(", ")}. Run board_list for ids.`);
      return { content: [{ type: "text", text: lines.join("\n") }], isError: closed.length === 0 };
    },
  });

  bb.agents.registerTool({
    name: "board_list",
    description: "List this thread's side board: open items first, then recently closed ones.",
    presentation: { label: { pending: "Reading the side board", completed: "Read the side board" }, suppress: true },
    parameters: z.object({ includeDone: z.boolean().optional() }),
    async execute({ includeDone }, { threadId }) {
      return formatBoard(await readBoard(threadId), includeDone ?? false);
    },
  });

  // Live counts, so an agent resuming a thread knows the board is not empty.
  // Contributions are synchronous; the cache is filled by thread.active below.
  const openSummary = new Map<string, string>();
  bb.agents.contributeInstructions(({ threadId }) => {
    const summary = threadId === null ? undefined : openSummary.get(threadId);
    return summary === undefined ? RULES : `${RULES}\n\nOpen right now: ${summary}. Run \`board_list\` for ids.`;
  });

  // ── Safety net ────────────────────────────────────────────────────────────
  // turnStartedAt: when the current turn began, so "touched this turn" means
  // touchedAt >= turnStartedAt. nudged: the turn now ending was our own
  // reminder, which never earns a second one.
  const turnStartedAt = new Map<string, string>();
  const nudged = new Set<string>();

  bb.events.on("thread.active", async ({ thread }) => {
    turnStartedAt.set(thread.id, new Date().toISOString());
    const c = counts(await readBoard(thread.id));
    const parts = [
      c.questions > 0 ? `${c.questions} question${c.questions === 1 ? "" : "s"}${c.blocking > 0 ? ` (${c.blocking} blocking)` : ""}` : null,
      c.bugs > 0 ? `${c.bugs} bug${c.bugs === 1 ? "" : "s"}` : null,
      c.todos > 0 ? `${c.todos} todo${c.todos === 1 ? "" : "s"}` : null,
    ].filter((part) => part !== null);
    if (parts.length === 0) openSummary.delete(thread.id);
    else openSummary.set(thread.id, parts.join(", "));
  });

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const startedAt = turnStartedAt.get(thread.id);
    turnStartedAt.delete(thread.id);
    if (nudged.delete(thread.id)) return;
    // No start time means the plugin loaded mid-turn; it cannot tell what the
    // turn touched, so it stays quiet.
    if (!nudge || startedAt === undefined || lastAssistantText === null) return;
    const board = await readBoard(thread.id);
    const touched = board.touchedAt !== null && board.touchedAt >= startedAt;
    const miss = detectMiss(lastAssistantText, board, touched);
    if (!miss.unboarded && !miss.unclosed) return;
    nudged.add(thread.id);
    try {
      await bb.sdk.threads.send({
        threadId: thread.id,
        mode: "auto",
        input: [{ type: "text", text: nudgeText(miss), mentions: [] }],
      });
    } catch (cause) {
      nudged.delete(thread.id);
      bb.log.warn(`nudge failed for ${thread.id}: ${String(cause)}`);
    }
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    await bb.storage.kv.delete(key(thread.id));
  });
}
