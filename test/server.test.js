// The console holds owner tokens: these lock down who may reach it. Runs the real bin against a fake Controller.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let home, controller, proc, base, key, seen;

function req(path, { method = "GET", headers = {} } = {}) {
  return new Promise((ok, no) => {
    const r = http.request(base + path, { method, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => ok({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on("error", no);
    r.end();
  });
}

before(async () => {
  controller = http.createServer((q, s) => {
    seen = { url: q.url, auth: q.headers.authorization, cookie: q.headers.cookie, origin: q.headers.origin };
    s.writeHead(200, { "content-type": "application/json" });
    s.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => controller.listen(0, "127.0.0.1", r));
  home = mkdtempSync(join(tmpdir(), "a12s-console-test-"));
  mkdirSync(join(home, ".a12s", "demo"), { recursive: true });
  writeFileSync(join(home, ".a12s", "demo", "controller.json"), JSON.stringify({ port: controller.address().port, token: "owner-secret" }));
  proc = spawn(process.execPath, [join(root, "bin", "a12s-console.js"), "--no-open", "--port", "0"], {
    env: { ...process.env, A12S_HOME: home, A12S_URL: "", A12S_TOKEN: "" },
    cwd: home,
  });
  const line = await new Promise((ok, no) => {
    let out = "";
    proc.stdout.on("data", (d) => {
      out += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?key=(\S+)/.exec(out);
      if (m) ok(m);
    });
    proc.on("exit", (c) => no(new Error(`exited ${c}: ${out}`)));
  });
  base = line[1];
  key = line[2];
});

after(() => {
  proc?.kill();
  controller?.close();
  rmSync(home, { recursive: true, force: true });
});

test("no key: the API is closed and the owner token never leaks", async () => {
  const r = await req("/f/demo/v1/status");
  assert.equal(r.status, 401);
  assert.ok(!r.body.includes("owner-secret"));
  assert.equal((await req("/console/fleets")).status, 401);
});

test("a wrong key is refused", async () => {
  assert.equal((await req("/?key=nope")).status, 403);
});

test("the key becomes an HttpOnly SameSite=Strict cookie and leaves the URL", async () => {
  const r = await req(`/?key=${key}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, "/");
  const c = r.headers["set-cookie"][0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  const cookie = c.split(";")[0];
  const f = await req("/console/fleets", { headers: { cookie } });
  assert.equal(f.status, 200);
  assert.deepEqual(JSON.parse(f.body).fleets.map((x) => x.name), ["demo"]);
  assert.ok(!f.body.includes("owner-secret"), "fleet list must not carry tokens");
});

test("proxied calls carry the owner token, never the browser's cookie or origin", async () => {
  const r = await req("/f/demo/v1/status?x=1", { headers: { authorization: `Bearer ${key}` } });
  assert.equal(r.status, 200);
  assert.equal(seen.url, "/v1/status?x=1");
  assert.equal(seen.auth, "Bearer owner-secret");
  assert.equal(seen.cookie, undefined);
});

test("DNS rebinding: a non-loopback Host is refused", async () => {
  const r = await req("/f/demo/v1/status", { headers: { host: "evil.example.com", authorization: `Bearer ${key}` } });
  assert.equal(r.status, 403);
});

test("cross-origin writes are refused", async () => {
  const r = await req("/f/demo/v1/agent-computers/x", { method: "DELETE", headers: { origin: "https://evil.example.com", authorization: `Bearer ${key}` } });
  assert.equal(r.status, 403);
});

test("an unknown Fleet is a 404, not a proxy anywhere", async () => {
  const r = await req("/f/nope/v1/status", { headers: { authorization: `Bearer ${key}` } });
  assert.equal(r.status, 404);
});
