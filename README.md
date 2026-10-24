# agent-canvas (prototype)

A standalone Paseo plugin: any agent shows its work as a live canvas (whitelisted components, parsed not executed, patched by id), drawn natively in the agent pane and as HTML in a browser, with a Paseo-owned honesty strip. Self-contained so it can move to its own repo.

- `shared/` vocabulary, parser, validator, patching, honesty cross-checks, auto canvas (pure, tested)
- `server/` hub (state, Paseo facts, pane row), MCP + HTTP server, HTML renderer
- `client/` React Native renderer, screen, panel, composer pill
- `skill/agent-canvas/` the agent-facing skill
- `demo/` demo agents and `start.sh`
- `npm run typecheck`, `npm test`
