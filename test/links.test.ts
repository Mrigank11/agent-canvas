import { test } from "node:test";
import assert from "node:assert/strict";
import { agentDeepLink } from "../shared/links.ts";
import { Hub } from "../server/hub.ts";
import { renderCanvas } from "../server/html.ts";

test("deep link into the Paseo web UI uses the daemon's server id", () => {
  assert.equal(agentDeepLink("http://h:6781/", "srv_abc", "a-1"), "http://h:6781/h/srv_abc/agent/a-1");
  assert.equal(agentDeepLink("http://h:6781", null, "a-1"), null);
  assert.equal(agentDeepLink("http://h", "srv x", "a/b"), "http://h/h/srv%20x/agent/a%2Fb");
});

test("the browser canvas links back to its agent, and omits the link when there is none", () => {
  const mk = (agentLink?: (id: string) => string | null) => {
    const h = new Hub({ log: () => {}, stateFile: null, publicBase: "http://c", localBase: "http://l", agentLink, policy: () => ({ defaultOn: true, autoCanvas: true }) });
    h.set("a1", `<Canvas title="T"><Bluf>x</Bluf></Canvas>`);
    return renderCanvas(h.view("a1")!, Date.now());
  };
  const html = mk((id) => agentDeepLink("http://h:6781", "srv_abc", id));
  assert.match(html, /href="http:\/\/h:6781\/h\/srv_abc\/agent\/a1"[^>]*>Open agent in Paseo/);
  assert.doesNotMatch(mk(), /Open agent in Paseo/);
  assert.doesNotMatch(mk(() => null), /Open agent in Paseo/);
});
