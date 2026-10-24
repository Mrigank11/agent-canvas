---
name: agent-canvas
description: Use when you have a live canvas (canvas_set / canvas_patch tools, or the agent-canvas HTTP endpoint) and need to show your work, progress or a question to the human as a live visual view instead of chat.
---

# agent-canvas

Show your work as a live canvas the human watches instead of reading chat. Write it in this component vocabulary (TSX-shaped, but it is only PARSED: no code, no expressions, no HTML tags).

<Canvas title="…" status="working|done|blocked|waiting">   root, exactly one
  <Bluf>one-line bottom line: what is true right now</Bluf>
  <Steps title="…"><Step id="build" state="pending|active|done|failed|skipped">label</Step></Steps>
  <Progress value={40} max={100} label="…" />
  <Metric label="Tests" value="12/14" tone="info|warn|error|success" />
  <Decision title="…" chosen="…">why</Decision>
  <Ask id="q1" question="…" blocking><Option value="a">Label A</Option><Option value="b">Label B</Option></Ask>
  <Markdown id="notes">standard GitHub Markdown: headings, lists, task lists, tables, fenced code, links, > [!WARNING] alerts</Markdown>
  <Diff file="a.ts">unified diff</Diff>
  <Chart kind="bar|line" title="…" data="label:1,label:2" />
</Canvas>

Prose, tables, code, links and callouts go in <Markdown>, written as you would anywhere else. Raw HTML in it shows as text, links must be http(s) or mailto, and images are not supported yet. Markdown and Diff bodies are written as-is: no escaping inside them.
Rules: attribute values are "strings", {numbers} or {true}/{false}. In other text write &lt; and &amp; for a literal < or &. Give an id to anything you will patch later (letters, digits, - and _).
Keep it live: call canvas_set once at the start, then canvas_patch as each step moves (ops: {id, set:{state:"done"}}, {id, text:"new body"}, {parent, append:"<Step …>…</Step>"}, {id, remove:true}). Update at every real state change, not at the end only.
Be honest: a Paseo-owned strip above your canvas shows your real run state, and it flags a canvas that says done while you are still running or one that has gone stale. Set status="done" only when you are finished and about to stop.
To ask the human something, add an <Ask> and END YOUR TURN: the answer arrives as your next message. Never keep working while waiting.

## Tools

- `canvas_set(source)`: replace the whole canvas. Validation errors come back as the tool result; fix and resend.
- `canvas_patch(ops)`: atomic edits by element id.
- `canvas_get()`: read the current source and ids back.

No canvas tool in this session? Ask the human to press the Canvas pill and choose "Tell this agent to use a canvas": you will receive curl recipes for the same operations.
