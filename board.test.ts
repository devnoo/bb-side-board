import { describe, expect, it } from "vitest";
import { addItems, closeItems, closeSchema, detectMiss, emptyBoard, formatBoard, renderMarkdown } from "./board";

const NOW = "2026-10-26T12:00:00.000Z";

describe("addItems", () => {
  it("numbers ids per kind, monotonically", () => {
    const first = addItems(
      emptyBoard(),
      [
        { kind: "question", title: "Clerk or Lucia?", recommendation: "Clerk" },
        { kind: "bug", title: "500 on second click", location: "src/cb.ts:31" },
        { kind: "question", title: "Postgres or SQLite?" },
      ],
      NOW,
    );
    expect(first.added.map((item) => item.id)).toEqual(["Q1", "B1", "Q2"]);
    const second = addItems(first.board, [{ kind: "question", title: "Again?" }], NOW);
    expect(second.added[0]?.id).toBe("Q3");
  });

  it("keeps only the fields that belong to the kind", () => {
    const { added } = addItems(
      emptyBoard(),
      [{ kind: "todo", title: "Backfill", recommendation: "x", blocking: true, estimate: "~10 min" }],
      NOW,
    );
    expect(added[0]).toMatchObject({ recommendation: null, blocking: false, estimate: "~10 min" });
  });
});

describe("closeItems", () => {
  it("closes known ids and reports unknown ones", () => {
    const { board } = addItems(emptyBoard(), [{ kind: "bug", title: "Broken" }], NOW);
    const result = closeItems(
      board,
      [closeSchema.parse({ id: "b1", resolution: "fixed in x.ts" }), closeSchema.parse({ id: "T9", resolution: "-" })],
      NOW,
    );
    expect(result.closed.map((item) => item.id)).toEqual(["B1"]);
    expect(result.missing).toEqual(["T9"]);
    expect(formatBoard(result.board, true)).toBe("B1 [done] Broken → fixed in x.ts");
  });
});

describe("detectMiss", () => {
  const withTodo = addItems(emptyBoard(), [{ kind: "todo", title: "Write docs" }], NOW).board;

  it("flags a question that never reached the board", () => {
    expect(detectMiss("Should I use Clerk or Lucia?", emptyBoard(), false).unboarded).toBe(true);
  });

  it("ignores replies that already reference board ids", () => {
    expect(detectMiss("Q1 · Clerk or Lucia?", emptyBoard(), false).unboarded).toBe(false);
  });

  it("ignores questions inside code blocks and quotes", () => {
    const text = "Done reading.\n```ts\nconst a = b ? c : d?\n```\n> was it ok?";
    expect(detectMiss(text, emptyBoard(), false).unboarded).toBe(false);
  });

  it("flags finished work while board items stay open", () => {
    expect(detectMiss("The docs are written and done.", withTodo, false).unclosed).toBe(true);
    expect(detectMiss("The docs are written and done.", emptyBoard(), false).unclosed).toBe(false);
  });

  it("stays quiet when the board was touched this turn", () => {
    expect(detectMiss("Clerk or Lucia?", withTodo, true)).toEqual({ unboarded: false, unclosed: false });
  });
});

describe("renderMarkdown", () => {
  it("renders the original board shape: marked headings, badges, struck closes", () => {
    let { board } = addItems(
      emptyBoard(),
      [
        { kind: "question", label: "Auth provider", title: "Clerk or Lucia?", detail: "Gating /dashboard.", recommendation: "Clerk", alternatives: ["Lucia — no lock-in"], blocking: true },
        { kind: "question", label: "Database", title: "Postgres or SQLite?" },
        { kind: "bug", title: "500 on second click", location: "src/cb.ts:31" },
        { kind: "todo", title: "Backfill deleted_at", estimate: "~10 min" },
      ],
      NOW,
    );
    board = closeItems(board, [closeSchema.parse({ id: "Q2", resolution: "Postgres" })], NOW).board;
    const md = renderMarkdown(board, "14:32");
    expect(md).toContain("`1 open` · `1 bug` · `1 todo` · updated 14:32");
    expect(md).toContain("### ⬜🔒 Q1 · Auth provider");
    expect(md).toContain("blocking-e5484d");
    expect(md).toContain("<details><summary>why this came up · context</summary>");
    expect(md).toContain("- 🟢 **Recommend:** Clerk");
    expect(md).toContain("<summary>✅ Closed (1)</summary>");
    expect(md).toContain("🟢 **Answered: Postgres**");
    expect(md).toContain("- 🔴 **B1** 500 on second click — `src/cb.ts:31`");
    expect(md).toContain("- ☐ **T1** Backfill deleted_at · ~10 min");
    // Open questions, then open todos, then open bugs, then the closed block.
    const order = ["### ⬜🔒 Q1", "## Todos", "## Bugs", "✅ Closed", "### ✅ Q2"].map((part) => md.indexOf(part));
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it("keeps agent text from opening raw HTML", () => {
    const { board } = addItems(emptyBoard(), [{ kind: "bug", title: "<script>x</script>" }], NOW);
    expect(renderMarkdown(board, null)).not.toContain("<script>");
  });
});
