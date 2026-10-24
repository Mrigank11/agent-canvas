# agent-canvas

A standalone Paseo plugin: any agent shows its work as a live canvas instead of the chat transcript. The agent writes it in a whitelisted, TSX-like vocabulary (steps, progress, metrics, questions with buttons, diffs, charts, tables). It is parsed, never executed, and patched by element id. It draws natively in the agent's pane, in an Explorer side panel, in a Canvases screen, and as HTML in a browser. A Paseo-owned status line, which the agent cannot write into, flags canvases that say "done" while the agent is still running, stale canvases and errors.

Status: prototype, running on Paseo 0.12 (`requirements.paseo: >=0.12.0 <0.13.0`). Extracted from the paseo-firstmate repo with its history.

## Develop and test

```
npm install        # dev dependencies for typechecking and tests only; Paseo supplies the runtime modules
npm run typecheck
npm test           # node --test, no network, no daemon needed
```

## Install into a Paseo daemon

```
paseo plugin install /absolute/path/to/agent-canvas        # add --host <url> or --home <dir> to target a daemon
paseo plugin ls
```
Plugins are trusted code; read `OVERVIEW.md` for what it does and where it listens (port 6790, `AGENT_CANVAS_PORT`; set `AGENT_CANVAS_PUBLIC_URL` and `AGENT_CANVAS_APP_URL` to the host name clients should use, the defaults point at one specific tailnet host).

## Demo

`demo/start.sh` starts six small demo agents against an isolated daemon (`CANVAS_DEMO_HOME`, default `~/.paseo-canvas-demo`; it refuses to run against `~/.paseo`). See `DEMO.md`.

## Layout

- `shared/` vocabulary, parser, validator, patching, honesty checks, render plan, UI tokens and rules (pure, tested)
- `server/` hub (state and Paseo facts), MCP and HTTP server, HTML renderer
- `client/` React Native renderer, screens, side panel, pill, settings
- `skill/agent-canvas/` the agent-facing skill; `demo/` demo agents; `test/` unit tests

## Content blocks (vocabulary v3)

Standard formats for content, custom tags for state. `<Markdown>` takes CommonMark + GFM (headings, lists, task lists, tables, fenced code, links, `> [!WARNING]` alerts) written as-is; the body is parsed server-side by `shared/markdown.ts`, our own dependency-free parser (the plugin has no runtime `node_modules`), into a tree that both renderers draw (`mdBlock` in `server/html.ts`, `MdBlockView` in `client/blocks.tsx`). Raw HTML is shown as text, links keep only `http(s):`/`mailto:`, and images are rejected until the `<Image>` block lands. Body limit 8,000 chars. `Table`/`Row`, `Note`, `Link` and `Code` are retired: they still parse for one release, are validated as before, then become a `Markdown` node with the same id (`convertRetired` in `shared/canvas.ts`), so patches and round-trips only ever see the new vocabulary. Tests: `test/markdown.test.ts`, `test/parity.test.ts`.

## Background jobs

A Claude Code agent that starts a background command or a Monitor and goes idle is waiting, not stuck. The status line shows one **Background** row per job under the Now row (spinner and timer while it runs, a check and the exit code for 10 minutes after, one red-tinted row for a failure), a compact chip ("2 in background") on the timeline card and in the Canvases list, and a **Waiting** verdict (pill "Waiting · 2") for an idle agent with a running job. A canvas that says done while a job runs, or that has not caught up with a failed job, is **Disputed**; jobs left running when the agent errors or closes are **lost**.

What the plugin can see (Paseo 0.12, Claude Code only): the start from Claude's result text (`running in background with ID: …`, `Monitor started (task …`), pinned in `shared/ui-spec.ts` with fixture tests; the finish from Paseo's `task_notification` items (`metadata.toolUseId` joins it to the launch, `metadata.status` decides done, failed or killed, the exit code is parsed from the summary text); times are the hub's first-seen stamps, so a job already running when the plugin first reads an agent shows "≥ 3m". A finish whose start was not recognised still appears, as a finished job. Codex and OpenCode agents show nothing. No output tails: that needs the daemon's disk, outside the Paseo API. Rules: `shared/honesty.ts`; rows and chip: `backgroundPlan` in `shared/plan.ts`; tests: `test/background.test.ts`.

## Who gets a canvas (configuration)

Precedence: **per-agent override, then the global switch, then the default.** One resolver, `shared/config.ts` (`resolveCanvas`), unit-tested for every combination.

**Global switch** (Settings → Plugins → agent-canvas ⋯ → Agent canvas; stored at `<daemon home>/plugin-settings/agent-canvas/canvas.json`):

| Setting | Default | Meaning |
|---|---|---|
| `defaultOn` | off | Give every new agent the canvas tools (the MCP server is injected at creation). Off: only agents with the override get them. |
| `autoCanvas` | on | Show a canvas built from the agent's timeline for agents that write none and have no override. Its own toggle. |

Everything off means an agent with no override has no canvas of any kind: no tools, no pane card, not in the Canvases list or the browser view.

**Per-agent override** (beats the global switch both ways; values `on`/`true`/`1`/`yes`, `off`/`false`/`0`/`no`):

| How | When | What it gives |
|---|---|---|
| env `AGENT_CANVAS=on` (or `off`) | at creation: `paseo run --env AGENT_CANVAS=on`, SDK create with `env` | `on`: the real `canvas_set`/`canvas_patch` tools. `off`: no tools, no canvas, even if the global switch is on. |
| label `canvas=on` (or `off`) | at creation, via `labels` | The only thing the MCP `create_agent` tool can set (it has no env). Nothing is visible in the create hook, so the plugin reads the label once the agent exists and, after its first turn starts, sends it the plain-HTTP (curl) recipe. `off` hides it. |
| Canvas pill → Turn on / off for this agent | at runtime | Same as the label for `on` (recipe sent at once); wins over env and label until "Use the default". |

The latest explicit source wins: pill, then env, then label.

**What Phase 5 (first mate) calls** to enable the canvas for an agent it starts:

```
mcp__paseo__create_agent({
  provider: "...", title: "...", initialPrompt: "...", workspaceId: "...",
  labels: { "canvas": "on" }          // plus whatever fm.* labels it uses
})
```
This gives the agent the HTTP recipe, not MCP tools; every provider with a shell can use it. If real tools are wanted, either turn the global `defaultOn` switch on (first-mate agents then get the MCP tools at creation), or create through the CLI/SDK with `AGENT_CANVAS=on` in the env.

### Label path timing, and how Phase 5 avoids waiting

Labels are not visible to the plugin when an agent is created (the `agent.create` and `agent.session_open` hooks carry only the config and env; checked on 0.12). The plugin reads the label right after creation and, once the agent's first turn has started, sends it the curl recipe as a steering message. On a normal first turn this lands before the agent's first tool call (checked), but it is a message **after** the initial prompt, so a first turn that is only a few seconds long, or a provider that queues steering until the turn ends, can finish first and the recipe starts a second turn.

To have the recipe from the very first token, put it in the brief. Every agent's shell has its own id in `$PASEO_AGENT_ID`, so one fixed snippet works for any agent:

```
node server/brief-snippet.ts 6790      # prints the recipe with .../api/canvas/$PASEO_AGENT_ID
```

Paste its output under a "## Your canvas" heading in the crew brief and still set `labels: { canvas: "on" }`: the label turns the canvas on for that agent (the endpoint answers "off for this agent" until the label has been read, a few hundred milliseconds after creation, and the snippet tells the agent to retry), and the snippet removes the wait.
