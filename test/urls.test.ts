import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { resolveUrls, LOCAL_CONFIG } from "../server/urls.ts";

test("urls: env beats the local file, which beats the localhost defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "ac-urls-"));
  assert.deepEqual(resolveUrls({}, dir, 6790), { publicUrl: "http://127.0.0.1:6790", appUrl: "http://127.0.0.1:6781" });
  writeFileSync(join(dir, LOCAL_CONFIG), JSON.stringify({ publicUrl: "http://h.example.ts.net:6790/", appUrl: "http://h.example.ts.net:6781" }));
  assert.deepEqual(resolveUrls({}, dir, 6790), { publicUrl: "http://h.example.ts.net:6790", appUrl: "http://h.example.ts.net:6781" });
  assert.deepEqual(resolveUrls({ AGENT_CANVAS_PUBLIC_URL: "http://env/" }, dir, 6790), { publicUrl: "http://env", appUrl: "http://h.example.ts.net:6781" });
  writeFileSync(join(dir, LOCAL_CONFIG), "not json");
  assert.equal(resolveUrls({}, dir, 7000).publicUrl, "http://127.0.0.1:7000");
});
