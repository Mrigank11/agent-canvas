Agent canvas gives any Paseo agent a live visual view of its work in place of the chat transcript.

An agent writes a short canvas in a fixed set of components (steps, progress, metrics, questions with buttons, diffs, charts, tables). The canvas is parsed and never executed, and the agent updates it by element id. The same document draws natively in the agent pane, in a Canvases screen, and as a web page you can open in any browser on your network.

A strip above every canvas is written by Paseo, not by the agent. It shows the real run state and the current tool, and flags canvases that say done while the agent is still running, canvases that have gone stale, and agents that errored. An agent that never writes a canvas still gets one derived from its timeline.

## Setup

Requires Paseo 0.12. Start an agent with the environment variable AGENT_CANVAS=on to give it the canvas tools. For an agent already running, use the Canvas pill in the composer. The browser view listens on port 6790 of the daemon machine (AGENT_CANVAS_PORT, AGENT_CANVAS_BIND and AGENT_CANVAS_PUBLIC_URL change this).

## Known limits

The browser view and the answer endpoint have no login, so bind them to a private network only. Charts draw as bars on native screens. The Paseo-owned live run state comes from the daemon in the pane and the Canvases screen, and from the client in the Canvas panel.
