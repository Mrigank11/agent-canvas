# agent-canvas (prototype)

A standalone Paseo plugin: any agent shows its work as a live canvas (whitelisted components, parsed not executed, patched by id), drawn natively in the agent pane and as HTML in a browser, with a Paseo-owned honesty strip. Self-contained so it can move to its own repo.

- `shared/` vocabulary, parser, validator, patching, honesty cross-checks, auto canvas (pure, tested)
- `server/` hub (state, Paseo facts, pane row), MCP + HTTP server, HTML renderer
- `client/` React Native renderer, screen, panel, composer pill
- `skill/agent-canvas/` the agent-facing skill
- `demo/` demo agents and `start.sh`
- `npm run typecheck`, `npm test`

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
node agent-canvas/server/brief-snippet.ts 6790      # prints the recipe with .../api/canvas/$PASEO_AGENT_ID
```

Paste its output under a "## Your canvas" heading in the crew brief and still set `labels: { canvas: "on" }`: the label turns the canvas on for that agent (the endpoint answers "off for this agent" until the label has been read, a few hundred milliseconds after creation, and the snippet tells the agent to retry), and the snippet removes the wait.
