---
name: side-board
description: How to keep this thread's side board — the panel listing open questions (Q1), bugs (B1) and todos (T1) — current with the board_add, board_close and board_list tools. Use when asking the user a question, noticing a bug, deferring work, or when the user answers by id ("Q3 clerk", "go").
---

# Side board

Every bb thread has a side board: a panel beside the chat with the conversation's open
questions, bugs and todos. The user reads it instead of scrolling the chat back, so it must
never miss an item, and every item must be closed when it is resolved.

## Record

| You… | Call | Include |
| --- | --- | --- |
| need the user to answer or decide | `board_add` kind `question` | a 1-4 word `label`, one `recommendation`, up to 3 `alternatives` with trade-offs, `blocking: true` only if you cannot continue |
| notice something broken you were not asked to fix | `board_add` kind `bug` | `location`: file:line or a command that shows it |
| defer work, or leave the user a later step | `board_add` kind `todo` | a concrete `estimate` (`~15 min`, `an afternoon`) |

- Add every item from the same turn in one `board_add` call.
- Record a bug, then go back to the task. Don't fix it mid-task.
- A question that is not blocking: proceed on your recommendation and say so.

## Close

Call `board_close` in the same turn an item is resolved, with a one-line `resolution`:

- User answers `Q3 clerk` → close Q3 with `Clerk`.
- User says `go` → close every open question with its recommendation.
- You fix B2 or finish T4 → close it with what you did.
- An item no longer matters → close it with why it was dropped.

## Chat

Refer to items by id only. For new open questions write one line each, then how to answer:

```
Q3 · Clerk or Lucia? (recommend Clerk)
Q4 · Soft or hard delete? (recommend soft)
Answer by id, e.g. `Q3 lucia`, or `go` to take all recommendations.
```

Don't restate bugs and todos in prose. The panel shows them. Use `board_list` when you need
the current ids.
