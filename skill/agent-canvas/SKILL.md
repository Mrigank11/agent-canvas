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
  <Svg id="arch" alt="what it shows"><svg viewBox="0 0 400 200">…</svg></Svg>   a drawing you write by hand: the right choice for any figure that explains (architecture sketch, sequence, a 3-8 step flow, before/after)
  <Image src="out/chart.png" alt="…" />   a PNG/JPEG/WebP/GIF file inside your workspace
  <Diff file="a.ts">unified diff</Diff>
  <Diagram id="flow" lang="dot" alt="…">digraph { a -> b }</Diagram>   Graphviz DOT, auto-laid-out: for a big graph or when layout is the hard part (dependency graphs, state machines)
  <Chart id="sales" lang="vega-lite" alt="…">{"data":{"values":[{"x":"a","y":1}]},"mark":"bar","encoding":{"x":{"field":"x","type":"nominal"},"y":{"field":"y","type":"quantitative"}}}</Chart>   Vega-Lite v5 JSON: bar, line, area, scatter, pie (arc), gantt (bar with x2)
</Canvas>

Prose, tables, code, links and callouts go in <Markdown>, written as you would anywhere else. Raw HTML in it shows as text and links must be http(s) or mailto. Markdown, Svg, Diagram, Chart and Diff bodies are written as-is: no escaping inside them.
Pictures: <Svg> takes plain SVG with a viewBox (shapes, paths, text, gradients; script, style, links and external references are removed, nothing is fetched). <Image src> and Markdown ![alt](path) show a file from your workspace only (max 3 MB, 4096 px, not a URL, not outside the folder). Diagrams and charts are rendered when you call canvas_set/canvas_patch: a DOT syntax error or an invalid Vega-Lite spec comes back as the error and nothing changes. DOT: max 8,000 chars, 300 nodes, 3 s to lay out; URL/href/image/stylesheet attributes are removed; colour with color=ok|run|warn|err|idle. Vega-Lite: JSON spec, inline data.values only (max 5,000 rows, 16,000 chars), no data.url or href. Patch a diagram or chart with {id, text:"new body"}. Max 8 pictures, diagrams and charts per canvas.
Figures: drawings show at natural size (1 unit = 1 px; a wide one scrolls sideways), so size them for reading. For a figure that EXPLAINS (how parts fit, a flow of 3-8 steps, before/after), hand-write <Svg> the way a designer would: viewBox about 640 wide, text 12-14, rounded rects (rx 10) with soft fills (fill="currentColor" fill-opacity=".06", stroke the same at .25), thin muted connectors (stroke="currentColor" stroke-opacity=".5", width 1.5), one emphasised element, a bold title with a muted second line, short labels. Use DOT only when the graph is big or its layout is the hard part; it is already styled (rounded tinted cards, muted edges): color=ok|run|warn|err|idle tints a node, emphasis=true marks the one that matters, and a two-line label is label=<<b>Build</b><br/><font point-size="11" color="gray">npm run build</font>>.
Rules: attribute values are "strings", {numbers} or {true}/{false}. In other text write &lt; and &amp; for a literal < or &. Give an id to anything you will patch later (letters, digits, - and _).
Keep it live: call canvas_set once at the start, then canvas_patch as each step moves (ops: {id, set:{state:"done"}}, {id, text:"new body"}, {parent, append:"<Step …>…</Step>"}, {id, remove:true}). Update at every real state change, not at the end only.
Be honest: a Paseo-owned strip above your canvas shows your real run state, and it flags a canvas that says done while you are still running or one that has gone stale. Set status="done" only when you are finished and about to stop.
To ask the human something, add an <Ask> and END YOUR TURN: the answer arrives as your next message. Never keep working while waiting.

## Tools

- `canvas_set(source)`: replace the whole canvas. Validation errors come back as the tool result; fix and resend.
- `canvas_patch(ops)`: atomic edits by element id.
- `canvas_get()`: read the current source and ids back.

No canvas tool in this session? Ask the human to press the Canvas pill and choose "Tell this agent to use a canvas": you will receive curl recipes for the same operations.

## A hand-written figure

A starting point for an explanatory `<Svg>` (a four-box flow with one emphasised step; copy the shape, change the words):

```
<Svg id="flow" alt="Release pipeline: now at Test">
<svg viewBox="0 0 640 110" font-family="ui-sans-serif, system-ui, sans-serif">
  <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,1L9,5L0,9z" fill="currentColor" fill-opacity=".5"/></marker></defs>
  <rect x="10" y="20" width="120" height="58" rx="10" fill="currentColor" fill-opacity=".06" stroke="currentColor" stroke-opacity=".25"/>
  <text x="24" y="44" font-size="14" font-weight="600" fill="currentColor">Source</text><text x="24" y="63" font-size="12" fill="currentColor" fill-opacity=".6">main @ 44cf1938</text>
  <rect x="170" y="20" width="120" height="58" rx="10" fill="#299f51" fill-opacity=".1" stroke="#299f51" stroke-opacity=".6"/>
  <text x="184" y="44" font-size="14" font-weight="600" fill="currentColor">Build</text><text x="184" y="63" font-size="12" fill="currentColor" fill-opacity=".6">done in 41 s</text>
  <rect x="330" y="20" width="130" height="58" rx="10" fill="#b37824" fill-opacity=".12" stroke="#b37824" stroke-width="2"/>
  <text x="344" y="44" font-size="14" font-weight="600" fill="currentColor">Test</text><text x="344" y="63" font-size="12" fill="currentColor" fill-opacity=".7">2 flaky, retrying</text>
  <rect x="500" y="20" width="130" height="58" rx="10" fill="currentColor" fill-opacity=".06" stroke="currentColor" stroke-opacity=".25"/>
  <text x="514" y="44" font-size="14" font-weight="600" fill="currentColor">Ship</text><text x="514" y="63" font-size="12" fill="currentColor" fill-opacity=".6">waiting</text>
  <g fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5" stroke-linecap="round" marker-end="url(#ah)"><path d="M130 49H166"/><path d="M290 49H326"/><path d="M460 49H496"/></g>
  <text x="10" y="102" font-size="12" fill="currentColor" fill-opacity=".6">Tints: green done, amber in progress; the heavier stroke marks where we are.</text>
</svg>
</Svg>
```

Rules of the look: one concept per figure, left to right or top to bottom, aligned rows, a muted caption line, tones only where they mean something (the hues are the canvas's own: #299f51 ok, #268ae0 run, #b37824 warn, #f12e2f err). Put the explanation in `<Markdown>` beside the figure; SVG text does not wrap.
