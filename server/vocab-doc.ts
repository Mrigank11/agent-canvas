// The text agents see in the canvas tool descriptions and the skill: how to write and keep a canvas.
export const VOCAB_DOC = `Show your work as a live canvas the human watches instead of reading chat. Write it in this component vocabulary (TSX-shaped, but it is only PARSED: no code, no expressions, no HTML tags).

<Canvas title="…" status="working|done|blocked|waiting">   root, exactly one
  <Bluf>one-line bottom line: what is true right now</Bluf>
  <Steps title="…"><Step id="build" state="pending|active|done|failed|skipped">label</Step></Steps>
  <Progress value={40} max={100} label="…" />
  <Metric label="Tests" value="12/14" tone="info|warn|error|success" />
  <Decision title="…" chosen="…">why</Decision>
  <Ask id="q1" question="…" blocking><Option value="a">Label A</Option><Option value="b">Label B</Option></Ask>
  <Diff file="a.ts">unified diff lines, written as-is (no escaping inside Diff or Code)</Diff>
  <Chart kind="bar|line" title="…" data="label:1,label:2" />
  <Table cols="A|B"><Row>x|y</Row></Table>
  <Link href="https://…">text</Link>   <Note tone="info|warn|error|success">text</Note>   <Code lang="sh">…</Code>
</Canvas>

Rules: attribute values are "strings", {numbers} or {true}/{false}. In text write &lt; and &amp; for a literal < or &. Give an id to anything you will patch later (letters, digits, - and _).
Keep it live: call canvas_set once at the start, then canvas_patch as each step moves (ops: {id, set:{state:"done"}}, {id, text:"…"}, {parent, append:"<Step …>…</Step>"}, {id, remove:true}). Update at every real state change, not at the end only.
Be honest: a Paseo-owned strip above your canvas shows your real run state, and it flags a canvas that says done while you are still running or one that has gone stale. Set status="done" only when you are finished and about to stop.
To ask the human something, add an <Ask> and END YOUR TURN: the answer arrives as your next message. Never keep working while waiting.`;
