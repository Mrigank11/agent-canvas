# agent-canvas demo: how to try it

Repo `/home/mrigank/projects/llm-exp/agent-canvas` (extracted from the paseo-firstmate repo, history kept). Nothing here touches your live daemon: the demo runs its own daemon (home `/home/mrigank/.paseo-canvas-demo`, port **6781**) and its own canvas web server (port **6790**). The live daemon is `~/.paseo` on 6767 and was only ever read.

## 1. Open it

| What | Where |
|---|---|
| Browser view (all agents) | http://manjaro.tail2e75.ts.net:6790/ (same at http://100.101.33.17:6790/) |
| **Paseo web app, native view (easiest)** | **http://manjaro.tail2e75.ts.net:6781/** (same at http://100.101.33.17:6781/). The demo daemon now serves the Paseo web UI itself (`features.webUi.enabled: true` in its config, per paseo.sh/docs/web-ui), so the page auto-connects back to that daemon: no "add host" step. Open it from any device on your tailnet. |
| Other Paseo clients (desktop/phone app) | Add a **Direct connection**: host `manjaro.tail2e75.ts.net`, port **6781**, no SSL, no password. |
| Hosted app.paseo.sh | Does **not** work for this daemon from a normal browser: an https page cannot open the plain `ws://` connection (mixed content). Use the URL above instead. |

Verified: loaded the URL in plain headless Chrome (fresh profile, no special flags): the sidebar shows the demo workspaces and **Canvases** opens the native canvas screen. Not checked on a phone. There is no password on this daemon (tailnet only), and the page is plain http.

### Getting back to the agent from a canvas

- **Native (Canvases screen):** tap a tile, then **Open agent**: it opens that agent's workspace and chat in the app (verified: "Pick a database" landed on its own workspace).
- **Browser view (:6790):** every canvas page has **Open agent in Paseo ↗** next to the title. It opens `http://manjaro.tail2e75.ts.net:6781/h/<serverId>/agent/<agentId>` (Paseo's own route, checked in the app bundle) in a new tab. **Caveat:** open the web UI root (http://manjaro.tail2e75.ts.net:6781/) once in that browser first. On a brand-new browser profile the deep link alone redirects to the start page because the app has not registered the host yet; after the first visit it lands on the right agent (verified).
- Inside an agent's own pane the canvas is already the chat view, so there is no back link there.

## 2. What the six demo agents show

Six small Claude Sonnet 5.5 agents (cheapest model that works on this daemon; opencode/Muse is too old here). Each task is a few `sleep`s plus canvas calls. Nothing is real.

| Agent | What it shows |
|---|---|
| **Ship build 1.0.10** | An honest canvas moving live: steps tick over, a progress bar climbs, a metric turns green. About 40 s. |
| **Pick a database** | A table, a chart and a blocking **Ask**. The agent ends its turn and waits. It turns **Needs you**. Click a button: the answer goes straight to that agent, it adds a Decision block and finishes. |
| **Migration (says it's done)** | The honesty catch. It writes status done on its first move, then keeps working for ~2 min without updating. The strip shows **Disputed**: "Canvas says done, but Paseo shows the agent still running". It settles to Done when the agent stops. |
| **Indexing (forgot to update)** | Writes a canvas once, then runs 12 commands without patching. Shows **Stale** while running, then "agent is idle but the canvas still shows unfinished steps". |
| **Block showcase** | One of every vocabulary block, for looks. |
| **Plain worker (no canvas)** | Never uses the canvas. It still gets an **auto canvas** built from its timeline (task, recent tools, files touched). Tagged "auto canvas". |

## 3. What to click (design v2)

1. Open an agent workspace (e.g. **pick-a-database**). The chat carries a **slim card**: verdict, bottom line, current step, any open question with buttons. The canvas tool-call rows are hidden; every other tool call still shows.
2. The **pill above the composer** is the live glance: a coloured dot and a label that is Paseo's verdict (**Needs you**, **Disputed**, **Stale**, **Error**, **Done**, or steps done like **2/5** while it works). Press it: a **mini canvas** with the bottom line, steps and the Ask buttons (answer right there).
3. **Open side panel** (in the popover) opens the full canvas as a **Canvas tab in the Explorer side panel**, next to Files and Changes. It **follows the agent on screen**: open the **side-by-side** workspace (two agents, Block showcase and Plain worker) and switch agent tabs in the chat; the panel switches with them. Chips at the top of the panel pick an agent manually until the agent on screen changes.
4. Sidebar → **Canvases**: all agents with their verdicts; tap one, then **Open agent**. In the browser view use **Open agent in Paseo**.
5. On **Pick a database**, answer the question from the card, the pill, the panel or the browser.

How "follows the agent" works: the Explorer panel is per workspace and Paseo gives a panel no "focused agent" signal, so each pill's icon reports its agent when its composer appears, and the panel reads that. It is a workaround that depends on Paseo mounting only the visible agent's pill; it held in my test but is not a documented guarantee. If nothing is reported the panel shows the most active agent of the workspace.

The old agent-panel tab is gone; the "Open canvas" menu is replaced by the popover above.

### Design v2 (what changed visually)

All surfaces follow the v2 spec (the canvas design v2 report): a fixed six-state signal palette (needs you = green lamp, working = blue pulse, done = green check, idle = ring, disputed/stale = amber, error = red) from Paseo's own status colours, no coloured borders, tinted badges, step tick strips, a green-washed question and Canvases row, the best table values marked, deltas on metrics, and a light/dark browser view that follows the OS. The side panel has no "Open agent" button; it stays on the Canvases detail view and in the browser view. Answered questions show only "✓ choice". The timeline card dropped its "Full canvas" hint, and the idle-waiting flag now reads "Waiting for your answer" in the status line.

Code: `shared/ui-spec.ts` (tokens, signals, glyphs, rules) and `shared/plan.ts` (blocks and status to a render plan) feed both `client/ui/*` (native primitives) and `server/ui-html.ts` (HTML primitives and generated CSS variables). `test/parity.test.ts` fails if a colour literal, a copied signal mapping or a missing renderer appears.

### The Now row (what the agent is doing this second)

Under the status badge in the side panel, the browser strip and the pill popover (there is no timeline card): Paseo's tool icon, a humanised label ("Running a Python script", "Editing atoms.tsx", "Waiting 7s"), the target as a muted mono chip, and a ticking elapsed time. Unrecognised commands read "Running <first word>" with the raw first line. The agent's own canvas curls fold into a grey "Updating canvas". Tap it for the full command (max 8 lines, scrolls) and the last three actions. When idle it shows "Last: Edited atoms.tsx · 2m ago" for ten minutes, then hides. The hub stamps the start time the first time it sees a call running (accurate to about the 2.5 s poll). Rules: `classifyActivity` in `shared/ui-spec.ts`.

### Configuration (global switch and per-agent override)

The demo daemon's global switch is **OFF** (both toggles: tools for every agent, and auto canvas), set through Paseo's UI: **Settings → Plugins → agent-canvas ⋯ → Agent canvas**. With it off, only agents that carry an override have a canvas: the demo agents are started with env `AGENT_CANVAS=on` (the **Plain worker** has no override, so it has no canvas: it is absent from Canvases, the browser view and the pane), plus an optional seventh agent, `./start.sh labeled`, which is started with only the **label** `canvas=on`: it gets the plain-HTTP recipe after its first turn starts and writes its canvas with curl ("Enabled by label").

Precedence is **per-agent override, then global switch, then default**. Override keys, set when the agent is created:

- env `AGENT_CANVAS=on|off` (CLI `--env`, SDK): real canvas tools; `off` keeps them out and hides the agent.
- label `canvas=on|off`: the only thing the MCP `create_agent` tool can set (it has no env). The label is not visible in the daemon's create hook, so the agent gets the HTTP recipe after its first turn starts instead of MCP tools.
- the **Canvas pill**: Turn on / Turn off / Use the default for one running agent. The latest explicit choice wins.

**For Phase 5 (first mate):** `mcp__paseo__create_agent({ provider, title, initialPrompt, workspaceId, labels: { "canvas": "on" } })`. For real tools instead, turn `defaultOn` on, or create via CLI/SDK with `AGENT_CANVAS=on`. Full table in `README.md`.

**Label timing:** the label is not visible when the agent is created, so the recipe is sent right after its first turn starts (it arrived before the first tool call in my check). If a first turn is very short it can finish first. For zero wait, paste the output of `node server/brief-snippet.ts` into the brief (it uses `$PASEO_AGENT_ID`); see the README.

To flip the global switch in the demo, use the settings screen above (changes apply at once), or edit `/home/mrigank/.paseo-canvas-demo/plugin-settings/agent-canvas/canvas.json` (`{"defaultOn":false,"autoCanvas":false}`, wrapped as Paseo stores it) and reload the plugin.

## 4. Replay

The demo agents run once. To get a fresh run (e.g. to watch the Disputed window again):

```
cd /home/mrigank/projects/llm-exp/agent-canvas/demo
./start.sh reset          # archive everything on the demo daemon, start all six
./start.sh overconfident  # or: deploy | decision | silent | showcase | plain
```
`start.sh` refuses to run against `~/.paseo`. The agents are already freshly started as of this note, so Disputed/Stale are visible in the first ~2 minutes; later use `./start.sh overconfident` (~2 min window).

You can also make your own: `paseo --home /home/mrigank/.paseo-canvas-demo run --env AGENT_CANVAS=on --provider claude --model claude-sonnet-5-5 "…"`. `AGENT_CANVAS=on` is the opt-in: the plugin's `agent.create` hook injects the canvas MCP server for that agent.

## 5. Stop and clean up

```
paseo --home /home/mrigank/.paseo-canvas-demo plugin remove agent-canvas
paseo --home /home/mrigank/.paseo-canvas-demo daemon stop
rm -rf /home/mrigank/.paseo-canvas-demo /tmp/canvas-demo-work     # optional: wipes demo state
```
Always keep `--home /home/mrigank/.paseo-canvas-demo`. Without it `paseo` targets your live daemon. After a stop, `paseo --home /home/mrigank/.paseo-canvas-demo daemon start` brings it back; if the config is lost it must have `"listen": "100.101.33.17:6781"` and `"pluginsEnabled": true`, then `paseo --home … plugin install /home/mrigank/projects/llm-exp/agent-canvas`. The daemon died once under load during my testing and rewrote its own config; I restored it.

## 6. What is real and what is a prototype

Built: the vocabulary (Canvas, Bluf, Steps/Step, Progress, Metric, Decision, Ask/Option, Markdown, Diff, Chart; Table/Row, Link, Note and Code are retired and convert to Markdown) with a parser that never executes anything (unknown tags, expressions, `javascript:` links all rejected, errors with line numbers go back to the agent); atomic `canvas_set` / `canvas_patch` / `canvas_get` MCP tools injected at agent creation; the honesty cross-checks (done-but-running, stale, idle-unfinished, error dimming, Ask → Needs you only when idle); the auto canvas; the native Canvases screen, panel and pill; the HTML view; Ask answers sent to the agent. Tests: 33 in `agent-canvas` (parser, patching, honesty, hub, MCP, HTML escaping); the 206 `firstmate-deck` tests still pass.

## 7. Known limits

- **No auth** on the web view or the answer endpoint (tailnet only; the write endpoints use unguessable per-agent keys, the answer button does not).
- **Existing agents** cannot get MCP tools injected; the pill sends them a curl recipe instead. Untested end to end.
- **`useAgent` live state works only inside a workspace panel** (the host throws elsewhere), so the Canvases screen use the daemon's view of run state (refreshed about every 2.5 s) and the panel uses the client's. Ages tick on the client clock; a phone with a skewed clock shows skewed ages.
- **Explorer panel** verified on desktop-width web only: not on a narrow layout or a native phone. The follow-the-agent trick above is a workaround. Only the canvas tool-call rows are folded; folding all tool noise would hide what the agent did, and a transformer cannot tell which agents have canvases.
- **No timeline card.** The canvas no longer writes a row into the agent's timeline; it shows in the composer pill, the side panel, the Canvases screen and the browser. Rows written by older versions render as nothing (a blank renderer kept for one release).
- **Charts** draw as bars on native (no SVG in the plugin UI kit); the browser draws a real line chart.
- Only Claude agents were tried; per-provider MCP support is untested. Every agent on the daemon gets an auto canvas (no per-agent opt-out yet). Not built: `<Html src>`, canvas-line comments, firstmate integration (phase 5), the upstream drafts.
- `skill/agent-canvas/SKILL.md` is written but not installed anywhere; the tool descriptions carry the same guidance.
