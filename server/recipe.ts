// The plain-HTTP instructions for an agent that has no canvas tools. Used by the plugin (sent to a label- or pill-enabled
// agent) and by `node server/brief-snippet.ts` (pasted into a brief, so the agent has it from its very first turn).
import { VOCAB_DOC } from "./vocab-doc.ts";

/** `url` is the agent's endpoint, e.g. http://127.0.0.1:6790/api/canvas/<agentId> or .../$PASEO_AGENT_ID. */
export function recipe(url: string): string {
  return `You have a live canvas the human watches instead of your chat. This session has no canvas tool, so use plain HTTP with curl:
  set:   curl -s -X POST ${url} --data-binary @canvas.tsx
  patch: curl -s -X POST ${url}/patch -H 'content-type: application/json' -d '[{"id":"build","set":{"state":"done"}}]'
  read:  curl -s ${url}
Errors come back as JSON; fix them and retry. If it says the canvas is off for this agent right after you started, wait a few seconds and retry.

${VOCAB_DOC}`;
}

/** The recipe with the agent's own id taken from its shell environment: no per-agent value to fill in, so it can sit in a brief. */
export function briefSnippet(port = 6790): string {
  return recipe(`http://127.0.0.1:${port}/api/canvas/$PASEO_AGENT_ID`);
}
