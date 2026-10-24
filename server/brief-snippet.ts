// Prints the canvas recipe for pasting into an agent's brief: `node server/brief-snippet.ts [port]`
import { briefSnippet } from "./recipe.ts";
console.log(briefSnippet(Number(process.argv[2] ?? process.env.AGENT_CANVAS_PORT ?? 6790)));
