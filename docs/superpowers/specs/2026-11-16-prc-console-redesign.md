# PRC console redesign — follow the MiniMax Code mobile app

Status: implemented in the same change as this document (single source of truth
for the console's layout and message surface).

## 1. Why

The console was a first-cut operating surface: a dark two-column page with
`textContent` bubbles. It could drive a session but not read one — markdown
showed its own asterisks, a plan arrived as JSON, tool calls and reasoning were
invisible, and nothing was sized for the phone an operator actually holds.

The MiniMax Code Android app (`com.minimax.ai`, distributed through Play) is the
product's own answer to "control the desktop from a phone". This document ports
its information architecture and its message surface to the console, and records
where the console deliberately differs.

## 2. Reference

Taken from the Play listing's own screenshots (`docs` does not ship them; the
listing is the source):

| Screen | What the app does |
| --- | --- |
| Home | Circular hamburger, centred product title, circular "…". Under it a bound-device chip with a green dot, a muted `Pinned`/`Projects` label, then large single-line session titles with a small state dot on the right |
| Conversation | Circular back button, a pill of round actions, then the transcript: the operator's own turns as a light bubble on the right, the agent's answer as plain paragraphs on the background, and a muted `Thought 2 time(s), Used 2 tool(s) ›` row for everything that is not the answer |
| Composer | One rounded light-grey field, a `+` on the left, a circular send button on the right |
| Sheet | Full-width panel with rounded top corners, centred title, `×` on the left |

Tokens read off those screenshots: white page, near-black text, muted
`#8a8a8e`-class secondary text, light `#f2f2f4` surfaces, 16–28 px radii, system
sans at 19/17/15 px, circular 44 px icon buttons.

## 3. Console layout

One DOM, two layouts; the query decides which is visible, not the script.

- `< 900 px`: one column. `body[data-view="sessions"]` shows the session list,
  `body[data-view="conversation"]` shows the transcript. The header's left
  button is the hamburger in the first case and Back in the second.
- `>= 900 px`: the session list is a 300 px rail next to the transcript; the
  hamburger and Back are hidden and both panes are visible.

The device chip sits at the top of the session list, as in the app: green dot
when the producer is connected, the device's short id, and the generation. It
opens a picker listing every device the gateway knows, because a browser tab has
no other way to change its binding.

## 4. Message surface

Rows come from three sources that must render the same way: socket events, the
history page, and the optimistic echo the composer prints.

| Row | Rendering |
| --- | --- |
| `role=user`, `msg_type=1` | Right-aligned light bubble, radius 20, max 78 % width. The attachment count is shown as a line inside the bubble until M3 lands |
| `role=assistant`, `msg_type=1` | Plain paragraphs, no bubble: markdown through `markdown.js` (fences, headings, lists, quotes, tables, inline code, emphasis, links) |
| `msg_type=3` `todo_updated` | Collapsed row `Todo list 4/6 ›`, open while items are unsettled, listing `○ ● ✓ –` rows |
| `msg_type=3` `runtime.warning` | Amber row with the sentence; `code` stays in `title` |
| `msg_type=3` anything else | Dropped |
| `tool_calls` on any row | Collapsed `Used N tool(s) ›` row; open shows one line per call, `name · status · first line of args` |
| `thinking_duration_ms` | Collapsed `Thought for 6s ›` row |

Reasoning text itself stays out of the transcript: the console shows that the
agent thought and for how long, never the trace. That is a deliberate deviation
from the app, which reveals it behind the same chevron.

## 5. Composer and stream

- Rounded field, `Enter` sends and `Shift+Enter` breaks the line on a physical
  keyboard; the send button is the keyboard-independent path.
- While a turn streams, the send button turns into Stop (the gateway's
  `cmd.session.stop`), and the status line reads `thinking`/`streaming`.
- Streaming answers keep appending to the bubble they started in; the completed
  message replaces it instead of duplicating it.
- The transcript sticks to the newest row unless the operator has scrolled up.

## 6. Out of scope

Attachments, file browsing, a terminal, and side conversations remain
unimplemented: the gateway has no route for them (README §M1 limits).
