// Pure board logic: the data model, id allocation, open/close, the text the
// agent sees, and the idle-time heuristics. No bb imports, so it is unit-testable
// and server.ts stays wiring only.
import { z } from "zod";

export const KINDS = ["question", "bug", "todo"] as const;
export type Kind = (typeof KINDS)[number];

/** Id prefix per kind: Q1, B1, T1. Numbers are monotonic per thread and kind. */
export const PREFIX: Record<Kind, string> = { question: "Q", bug: "B", todo: "T" };

export const itemSchema = z.object({
  id: z.string(),
  kind: z.enum(KINDS),
  /** Questions: a 1-4 word heading label, e.g. "Auth provider". */
  label: z.string().nullable().default(null),
  title: z.string(),
  detail: z.string().nullable(),
  /** Questions: the recommended answer. */
  recommendation: z.string().nullable(),
  /** Questions: other viable answers, each with its trade-off. */
  alternatives: z.array(z.string()),
  /** Questions: the agent cannot continue without the answer. */
  blocking: z.boolean(),
  /** Bugs: file:line or a command that shows it. */
  location: z.string().nullable(),
  /** Todos: a concrete estimate such as "~15 min". */
  estimate: z.string().nullable(),
  status: z.enum(["open", "done"]),
  /** How it was closed: the answer, the fix, or why it was dropped. */
  resolution: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Item = z.infer<typeof itemSchema>;

export const boardSchema = z.object({
  items: z.array(itemSchema),
  counters: z.object({ question: z.number(), bug: z.number(), todo: z.number() }),
  /** Last time the agent changed the board; the idle heuristics compare against it. */
  touchedAt: z.string().nullable(),
});
export type Board = z.infer<typeof boardSchema>;

export const emptyBoard = (): Board => ({
  items: [],
  counters: { question: 0, bug: 0, todo: 0 },
  touchedAt: null,
});

export const newItemSchema = z.object({
  kind: z.enum(KINDS),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("One line. A question ends with '?'. A bug names the symptom. A todo names the action."),
  label: z.string().trim().max(40).optional().describe("Questions: a 1-4 word heading, e.g. 'Auth provider'."),
  detail: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe("1-2 lines: what you were doing when it came up and what the answer changes."),
  recommendation: z.string().trim().max(300).optional().describe("Questions: your recommended answer and why."),
  alternatives: z
    .array(z.string().trim().min(1).max(300))
    .max(3)
    .optional()
    .describe("Questions: other viable answers, each with its trade-off on the same line."),
  blocking: z.boolean().optional().describe("Questions: true when you cannot continue without the answer."),
  location: z.string().trim().max(300).optional().describe("Bugs: file:line or the command that shows it."),
  estimate: z.string().trim().max(60).optional().describe("Todos: a concrete estimate, e.g. '~15 min'."),
});
export type NewItem = z.infer<typeof newItemSchema>;

export const closeSchema = z.object({
  id: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[QBT]\d+$/, "ids look like Q1, B2, T3")),
  resolution: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("Questions: the answer given. Bugs: the fix. Todos: what was done, or why it was dropped."),
});
export type Close = z.infer<typeof closeSchema>;

export function addItems(board: Board, additions: NewItem[], now: string): { board: Board; added: Item[] } {
  const counters = { ...board.counters };
  const added = additions.map((addition): Item => {
    counters[addition.kind] += 1;
    return {
      id: `${PREFIX[addition.kind]}${counters[addition.kind]}`,
      kind: addition.kind,
      label: addition.kind === "question" ? (addition.label ?? null) : null,
      title: addition.title,
      detail: addition.detail ?? null,
      recommendation: addition.kind === "question" ? (addition.recommendation ?? null) : null,
      alternatives: addition.kind === "question" ? (addition.alternatives ?? []) : [],
      blocking: addition.kind === "question" && addition.blocking === true,
      location: addition.kind === "bug" ? (addition.location ?? null) : null,
      estimate: addition.kind === "todo" ? (addition.estimate ?? null) : null,
      status: "open",
      resolution: null,
      createdAt: now,
      updatedAt: now,
    };
  });
  return { board: { items: [...board.items, ...added], counters, touchedAt: now }, added };
}

export function closeItems(
  board: Board,
  closes: Close[],
  now: string,
): { board: Board; closed: Item[]; missing: string[] } {
  const byId = new Map(closes.map((close) => [close.id, close]));
  const closed: Item[] = [];
  const items = board.items.map((item) => {
    const close = byId.get(item.id);
    if (close === undefined) return item;
    byId.delete(item.id);
    const next: Item = { ...item, status: "done", resolution: close.resolution, updatedAt: now };
    closed.push(next);
    return next;
  });
  return { board: { ...board, items, touchedAt: now }, closed, missing: [...byId.keys()] };
}

export function counts(board: Board) {
  const open = board.items.filter((item) => item.status === "open");
  return {
    questions: open.filter((item) => item.kind === "question").length,
    blocking: open.filter((item) => item.blocking).length,
    bugs: open.filter((item) => item.kind === "bug").length,
    todos: open.filter((item) => item.kind === "todo").length,
  };
}

export function formatItem(item: Item): string {
  const mark = item.status === "done" ? "done" : item.blocking ? "open, blocking" : "open";
  const extra = item.recommendation ?? item.location ?? item.estimate;
  const tail = item.status === "done" ? ` → ${item.resolution}` : extra === null ? "" : ` · ${extra}`;
  return `${item.id} [${mark}] ${item.title}${tail}`;
}

/** One line per open item, then the most recent closed ones — bounded for tool output. */
export function formatBoard(board: Board, includeDone: boolean): string {
  const open = board.items.filter((item) => item.status === "open");
  const done = board.items.filter((item) => item.status === "done").slice(-20);
  const lines = open.map(formatItem);
  if (includeDone) lines.push(...done.map(formatItem));
  if (lines.length === 0) return "The board is empty.";
  return lines.join("\n");
}

/** Lines of prose outside code fences and quotes, where the heuristics look. */
function proseLines(text: string): string[] {
  let fenced = false;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && !/^\s*>/.test(line)) lines.push(line);
  }
  return lines;
}

const QUESTION = /\?\s*\**\s*$/;
const BUG_OR_TODO = /\b(bug|broken|regression|todo|follow[- ]?up|deferred|out of scope|separately)\b/i;
const DONE = /\b(fixed|done|completed|resolved|implemented|shipped|finished)\b/i;
/** A reply that only mentions board ids it just handled is not a miss. */
const BOARD_ID = /\b[QBT]\d+\b/;

export type Miss = { unboarded: boolean; unclosed: boolean };

/**
 * Did the last reply raise or finish something the board did not record?
 * Deliberately conservative: a false nudge costs a turn, a missed one only
 * costs a stale panel.
 */
export function detectMiss(lastAssistantText: string, board: Board, touchedThisTurn: boolean): Miss {
  if (touchedThisTurn) return { unboarded: false, unclosed: false };
  const lines = proseLines(lastAssistantText).filter((line) => !BOARD_ID.test(line));
  const raises = lines.some((line) => QUESTION.test(line) || BUG_OR_TODO.test(line));
  const hasOpen = board.items.some((item) => item.status === "open" && item.kind !== "question");
  const finishes = hasOpen && lines.some((line) => DONE.test(line));
  return { unboarded: raises, unclosed: finishes };
}

export function nudgeText(miss: Miss): string {
  const asks: string[] = [];
  if (miss.unboarded) {
    asks.push(
      "Your last reply asked a question or mentioned a bug or deferred work, but nothing was added to the side board. Add each one with `board_add`.",
    );
  }
  if (miss.unclosed) {
    asks.push("Your last reply finished work that is still open on the board. Close it with `board_close`.");
  }
  asks.push(
    "If nothing needs recording, reply only `board: nothing to record`. Do not repeat your previous answer.",
  );
  return `[side-board] ${asks.join(" ")}`;
}

// ── Panel rendering ──────────────────────────────────────────────────────────
// The panel shows the board as Markdown in the shape of the original
// questions/board.md: state-marked headings, one shields badge per question,
// context collapsed under the question, Recommend/Alt lines, and bug and todo
// lists that strike through when closed.

const BADGE = {
  blocking: "![blocking](https://img.shields.io/badge/blocking-e5484d?style=flat-square)",
  open: "![open](https://img.shields.io/badge/open-f5a524?style=flat-square)",
  answered: "![answered](https://img.shields.io/badge/answered-30a46c?style=flat-square)",
};

/** Agent text goes into Markdown; keep it from opening raw HTML. */
function inline(text: string): string {
  return text.replace(/</g, "&lt;").replace(/\n+/g, " ");
}

function plural(count: number, word: string): string {
  return `\`${count} ${word}${count === 1 ? "" : "s"}\``;
}

function questionBlock(item: Item): string {
  const done = item.status === "done";
  const marker = done ? "✅" : item.blocking ? "⬜🔒" : "⬜";
  const heading = item.label === null ? item.id : `${item.id} · ${inline(item.label)}`;
  const badge = done ? BADGE.answered : item.blocking ? BADGE.blocking : BADGE.open;
  const lines = [`### ${marker} ${heading}`, "", `${badge} **${inline(item.title)}**`, ""];
  if (done) {
    lines.push(`🟢 **Answered: ${inline(item.resolution ?? "")}**`, "");
    return lines.join("\n");
  }
  if (item.detail !== null) {
    lines.push("<details><summary>why this came up · context</summary>", "", inline(item.detail), "", "</details>", "");
  }
  if (item.recommendation !== null) lines.push(`- 🟢 **Recommend:** ${inline(item.recommendation)}`);
  for (const alternative of item.alternatives) lines.push(`- Alt: ${inline(alternative)}`);
  if (item.recommendation !== null || item.alternatives.length > 0) lines.push("");
  return lines.join("\n");
}

function bugLine(item: Item): string {
  const where = item.location === null ? "" : ` — \`${item.location.replace(/`/g, "")}\``;
  return item.status === "done"
    ? `- 🟢 ~~**${item.id}** ${inline(item.title)}~~ ${inline(item.resolution ?? "")}`
    : `- 🔴 **${item.id}** ${inline(item.title)}${where}`;
}

function todoLine(item: Item): string {
  const estimate = item.estimate === null ? "" : ` · ${inline(item.estimate)}`;
  return item.status === "done"
    ? `- ☑ ~~**${item.id}** ${inline(item.title)}~~`
    : `- ☐ **${item.id}** ${inline(item.title)}${estimate}`;
}

/** `updated` is a display time chosen by the caller (the panel's locale). */
export function renderMarkdown(board: Board, updated: string | null): string {
  const c = counts(board);
  const header = [`\`${c.questions} open\``, plural(c.bugs, "bug"), plural(c.todos, "todo")];
  if (updated !== null) header.push(`updated ${updated}`);
  const out = [header.join(" · "), ""];

  // Everything open comes first — questions, then todos, then bugs — newest
  // first within each. Everything closed folds into one block at the bottom.
  const newestFirst = (kind: Kind, status: Item["status"]) =>
    board.items.filter((item) => item.kind === kind && item.status === status).reverse();

  const openQuestions = newestFirst("question", "open");
  const openTodos = newestFirst("todo", "open");
  const openBugs = newestFirst("bug", "open");
  if (openQuestions.length > 0) out.push("## Questions", "", ...openQuestions.map(questionBlock));
  if (openTodos.length > 0) out.push("## Todos", "", ...openTodos.map(todoLine), "");
  if (openBugs.length > 0) out.push("## Bugs", "", ...openBugs.map(bugLine), "");

  const closedQuestions = newestFirst("question", "done");
  const closedTodos = newestFirst("todo", "done");
  const closedBugs = newestFirst("bug", "done");
  const closed = closedQuestions.length + closedTodos.length + closedBugs.length;
  if (closed > 0) {
    const nothingOpen = openQuestions.length + openTodos.length + openBugs.length === 0;
    out.push(`<details${nothingOpen ? " open" : ""}><summary>✅ Closed (${closed})</summary>`, "");
    out.push(...closedQuestions.map(questionBlock));
    if (closedTodos.length > 0) out.push(...closedTodos.map(todoLine), "");
    if (closedBugs.length > 0) out.push(...closedBugs.map(bugLine), "");
    out.push("</details>", "");
  }
  return out.join("\n").trimEnd() + "\n";
}
