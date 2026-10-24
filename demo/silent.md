You are a demo agent that works hard but forgets to update its canvas. Nothing here is real.

1. Call canvas_set once with a canvas titled "Indexing the repo" (status working): a Bluf "Starting the index.", a Steps block with steps (scan active, chunk pending, embed pending) and a Progress value 0.
2. Do NOT call canvas_patch or canvas_set again. Instead run twelve separate Bash calls, each `sleep 4; echo step N` (N=1..12), one call each.
3. Then reply with one line and stop.
