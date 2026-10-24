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

Standard formats for content, custom tags for state. `<Markdown>` takes CommonMark + GFM (headings, lists, task lists, tables, fenced code, links, `> [!WARNING]` alerts) written as-is; the body is parsed server-side by `shared/markdown.ts`, our own dependency-free parser (the plugin has no runtime `node_modules`), into a tree that both renderers draw (`mdBlock` in `server/html.ts`, `MdBlockView` in `client/blocks.tsx`). Raw HTML is shown as text and links keep only `http(s):`/`mailto:`. Body limit 8,000 chars. `Table`/`Row`, `Note`, `Link` and `Code` are retired: they still parse for one release, are validated as before, then become a `Markdown` node with the same id (`convertRetired` in `shared/canvas.ts`), so patches and round-trips only ever see the new vocabulary. Tests: `test/markdown.test.ts`, `test/parity.test.ts`.

### Layout: `<Grid>` and `<Collapse>`

`<Grid cols={1..3}>` lays any blocks side by side; `<Collapse title open>` folds them away. Both hold any block (including each other) and count toward the nesting limit, now 5. The plan (`grid`, `collapse` in `shared/plan.ts`) nests; the browser draws CSS grid and `<details>`, native draws flex rows and a pressable section. Below `GRID_COMPACT_BELOW` (560 px, `shared/ui-spec.ts`) both draw one column: the browser by media query, native by `gridColumns`. An unanswered `<Ask>` inside a Collapse forces it open, and surfaces that show only some kinds (timeline, popover, pill) see through layout to the Steps and Ask inside. Tests: `test/layout.test.ts`.

### Pictures: `<Svg>`, `<Image>` and Markdown images

- **`<Svg alt>`** takes agent-written SVG. It is *rebuilt*, not stripped (`shared/svg.ts`): a strict XML parse (no DTD or custom entities, so entity expansion is refused), then only `svg g rect circle ellipse line polyline polygon path text tspan defs marker linearGradient radialGradient stop clipPath` with presentation attributes are re-emitted, ids namespaced per drawing. `script`, `foreignObject`, `style`, `use`, `image`, `a`, `on*`, `style=`, any `href` that is not a local `#id` on a gradient, any `url()` that is not `url(#id)`, and the `xlink` namespace are gone. `viewBox` is required; max 48,000 chars and 2,000 elements. Corpus: `test/svg.test.ts`.
- **`<Image src alt>`** and Markdown `![alt](path)` show a file from the agent's own workspace (`server/render/images.ts`): `realpath` must stay inside the agent's cwd (symlinks out are refused), type by magic bytes (png, jpeg, webp, gif; SVG is refused here), at most 3 MB and 4096 px a side, never a URL (so the daemon cannot be made to fetch from the tailnet). The checked bytes are the ones cached and served. Max 8 pictures per canvas; total source limit is now 96,000 chars.
- **Pipeline** (`server/render/assets.ts`): a `RichRenderer` per format validates synchronously at `canvas_set`/`canvas_patch` (a bad picture fails the call, nothing changes), makes a content-addressed artefact (`sha256`), and later gives the browser safe markup (`inline`) or the phone a PNG (`raster`, light or dark, at the asked width). PNGs and image copies are cached on disk under `<paseo home>/agent-canvas/cache/` (pruned after a week). S3/S4 (DOT, Vega-Lite) are two more renderers that end in SVG and reuse `inline` and `rasterize`.
- **What reaches the clients:** the timeline row and RPCs carry a *wire* tree (`Assets.wire`): drawings and images hold a hash and a size instead of their body (a canvas with two 45 KB drawings serialises to about 1 KB). The browser inlines the rebuilt SVG and loads raster images from `/asset/<hash>`; native asks the plugin RPC `canvas.asset({hash, theme, width})`, which returns a PNG (or the small original) as base64 for a data URI, so it works over the Paseo connection on a phone.
- **No runtime dependencies, no native addon.** Paseo bundles `index.server.ts` with esbuild and runs it with no `node_modules` next to it; esbuild cannot load a `.node` file, so `@resvg/resvg-js` is out. `@resvg/resvg-wasm` is pure JS plus wasm and is *vendored*: `scripts/vendor-resvg.mjs` writes `server/vendor/` (the JS glue, the wasm gzipped as base64, and Liberation Sans Regular and Bold for text, since wasm has no system fonts). The server bundle is about 2 MB; resvg is initialised on first use. Licences: resvg MPL-2.0, Liberation Sans OFL.
- **Native `Image` is read off the host `react-native` module at render time** (`client/blocks.tsx`): Paseo documents only View, Text, Pressable, ScrollView and TextInput for plugin screens, and the host passes its whole `react-native` module through, so `Image` is expected but not promised. If it is missing, the alt text and an "Open in the browser view" link are shown instead of a crash. The native component has not been run on a device or in a renderer (none is available in this repo's test setup); `test/parity.test.ts` checks it reads the same plan fields as the HTML.
- Tests: `test/svg.test.ts`, `test/assets.test.ts` (fixtures in `test/fixtures/`), `test/parity.test.ts`.

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
