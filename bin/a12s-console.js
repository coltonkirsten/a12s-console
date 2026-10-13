#!/usr/bin/env node
// a12s console: serves the console's web app and proxies each running Fleet's API to it, with the owner token.
// Local only: it listens on loopback, answers only loopback Host names, and every request needs this run's key,
// which the browser trades once for an HttpOnly SameSite=Strict cookie (like Jupyter's token link).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fleetName } from "@coltonkirsten/a12s";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "dist");
const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

const usage = `a12s-console ${pkg.version}: a local web console for a12s Fleets

usage: a12s-console [--fleet <name>] [--port 7013] [--host 127.0.0.1] [--no-open]

  --fleet <name>  the Fleet to open first (default: the nearest fleet.yaml's, else the first running one)
  --port <n>      port on 127.0.0.1 (default 7013, or the next free one)
  --host <h>      loopback address to listen on (127.0.0.1, ::1 or localhost)
  --no-open       print the link, don't open the browser
  --url, --token  a Controller that isn't in ~/.a12s (also $A12S_URL and $A12S_TOKEN)

It finds every running Fleet in ~/.a12s/<fleet>/controller.json (written by a12s up) and acts as its owner.`;

function parseArgs(argv) {
  const o = { port: 7013, host: "127.0.0.1", open: true, fixedPort: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const val = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) fail(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
        console.log(usage);
        process.exit(0);
      case "-v":
      case "--version":
        console.log(pkg.version);
        process.exit(0);
      case "--fleet":
      case "-F":
        o.fleet = val();
        break;
      case "--port":
        o.port = Number(val());
        o.fixedPort = true;
        if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) fail(`--port must be 0 (any free port) to 65535`);
        break;
      case "--host":
        o.host = val();
        if (!loopbackHost(o.host)) fail(`the console listens only on this machine (127.0.0.1, ::1, localhost), not ${o.host}`);
        break;
      case "--no-open":
        o.open = false;
        break;
      case "--url":
        o.url = val();
        break;
      case "--token":
        o.token = val();
        break;
      default:
        fail(`unknown argument ${a}\n\n${usage}`);
    }
  }
  o.url ??= process.env.A12S_URL;
  o.token ??= process.env.A12S_TOKEN;
  return o;
}

function fail(msg) {
  console.error(`a12s-console: ${msg}`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
const a12sHome = join(process.env.A12S_HOME ?? homedir(), ".a12s");

// ---- Fleets ------------------------------------------------------------------------------------------------------

/** Every Fleet a Controller was started for, read fresh each time so a new `a12s up` (new port) is picked up. */
async function fleets() {
  const out = [];
  if (opts.url) out.push({ name: opts.fleet ?? "remote", url: opts.url.replace(/\/+$/, ""), token: opts.token ?? "" });
  let names = [];
  try {
    names = (await readdir(a12sHome, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // no ~/.a12s yet
  }
  for (const name of names.sort()) {
    try {
      const cf = JSON.parse(await readFile(join(a12sHome, name, "controller.json"), "utf8"));
      if (cf.port && cf.token && !out.some((f) => f.name === name)) out.push({ name, url: `http://127.0.0.1:${cf.port}`, token: cf.token });
    } catch {
      // no Controller for this one
    }
  }
  return out;
}

async function defaultFleet(list) {
  if (opts.fleet) return opts.fleet;
  for (let d = resolve(process.env.A12S_FLEET ? dirname(resolve(process.env.A12S_FLEET)) : process.cwd()); ; d = dirname(d)) {
    const f = join(d, "fleet.yaml");
    if (existsSync(f)) {
      const n = fleetName(await readFile(f, "utf8"));
      if (n) return n;
    }
    if (dirname(d) === d) break;
  }
  return list[0]?.name;
}

// ---- HTTP --------------------------------------------------------------------------------------------------------

const key = randomBytes(24).toString("base64url");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
let first;

function loopbackHost(h) {
  h = h.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function hostOnly(hostHeader = "") {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader);
  if (m) return m[1];
  return hostHeader.replace(/:\d+$/, "");
}

function sameKey(got) {
  const a = Buffer.from(String(got ?? "")), b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieName(req) {
  return "a12s-console-" + (/:(\d+)$/.exec(req.headers.host ?? "")?.[1] ?? "80");
}

function hasKey(req) {
  const want = cookieName(req) + "=";
  for (const part of (req.headers.cookie ?? "").split(/;\s*/)) if (part.startsWith(want) && sameKey(part.slice(want.length))) return true;
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") && sameKey(auth.slice(7));
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const security = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const locked = `<!doctype html><meta charset="utf-8"><title>a12s console</title><meta name="color-scheme" content="dark light">
<body style="font:14px ui-sans-serif,system-ui;margin:0;display:grid;place-items:center;height:100vh">
<div style="max-width:28em;line-height:1.5"><b>a12s console is locked.</b><br>Open the link it printed in your terminal
(<code>http://127.0.0.1:&lt;port&gt;/?key=…</code>), or run <code>a12s ui</code> again.</div>`;

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(dist, p));
  if (!file.startsWith(dist + sep) && file !== dist) return json(res, 404, { code: "not_found", message: "no such file" });
  let isAsset = p.startsWith("/assets/");
  if (!isAsset && (p === "/" || !existsSync(file) || !extname(file))) file = join(dist, "index.html"); // SPA routes
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": types[extname(file)] ?? "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-store",
      ...security,
    });
    res.end(body);
  } catch {
    if (!existsSync(join(dist, "index.html"))) return json(res, 500, { code: "not_built", message: "the console isn't built", fix: "npm run build" });
    json(res, 404, { code: "not_found", message: "no such file" });
  }
}

function proxy(req, res, fleet, path) {
  const target = new URL(fleet.url + path);
  const headers = { ...req.headers, host: target.host, authorization: `Bearer ${fleet.token}` };
  for (const h of ["cookie", "origin", "referer"]) delete headers[h];
  const up = http.request(target, { method: req.method, headers }, (r) => {
    const h = { ...r.headers };
    if (String(h["content-type"] ?? "").startsWith("text/event-stream")) h["x-accel-buffering"] = "no";
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  up.on("error", (err) =>
    res.headersSent
      ? res.destroy()
      : json(res, 502, {
          code: "controller_down",
          message: `Fleet ${fleet.name}'s Controller at ${fleet.url} isn't answering (${err.code ?? err.message})`,
          fix: "run a12s up in the Fleet's directory (a12s doctor says why it stopped)",
        }),
  );
  req.on("aborted", () => up.destroy());
  res.on("close", () => up.destroy());
  req.pipe(up);
}

async function handle(req, res) {
  if (!loopbackHost(hostOnly(req.headers.host))) {
    return json(res, 403, { code: "forbidden", message: `the console only answers http://127.0.0.1 or http://localhost, not ${req.headers.host}` });
  }
  const u = new URL(req.url, "http://x");
  const safe = req.method === "GET" || req.method === "HEAD";
  const origin = req.headers.origin;
  if (origin && !safe && origin !== `http://${req.headers.host}`) {
    return json(res, 403, { code: "forbidden", message: `cross-origin request from ${origin}` });
  }
  if (u.searchParams.has("key") && safe) {
    if (!sameKey(u.searchParams.get("key"))) return json(res, 403, { code: "forbidden", message: "wrong console key", fix: "open the link a12s-console printed" });
    u.searchParams.delete("key");
    res.writeHead(303, {
      "set-cookie": `${cookieName(req)}=${key}; Path=/; HttpOnly; SameSite=Strict`,
      location: u.pathname + (u.search || ""),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    return res.end();
  }
  if (!hasKey(req)) {
    if (req.headers["sec-fetch-mode"] === "navigate" || (req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", ...security });
      return res.end(locked);
    }
    return json(res, 401, { code: "unauthorized", message: "this console needs its key", fix: "open the link a12s-console printed" });
  }
  if (u.pathname === "/console/fleets") {
    const list = await fleets();
    return json(res, 200, { version: pkg.version, default: first ?? (await defaultFleet(list)), fleets: list.map((f) => ({ name: f.name, url: f.url })) });
  }
  const m = /^\/f\/([A-Za-z0-9-]+)(\/v1\/.*)$/.exec(u.pathname);
  if (m) {
    const fleet = (await fleets()).find((f) => f.name === m[1]);
    if (!fleet) return json(res, 404, { code: "not_found", message: `no running Fleet ${m[1]}`, fix: "run a12s up in its directory" });
    return proxy(req, res, fleet, m[2] + u.search);
  }
  if (!safe) return json(res, 405, { code: "invalid", message: "method not allowed" });
  return serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { code: "internal", message: String(err?.message ?? err) });
  });
});
server.headersTimeout = 10_000;
server.requestTimeout = 0; // event streams stay open

function listen(port) {
  return new Promise((ok, no) => {
    server.once("error", no);
    server.listen(port, opts.host, () => {
      server.off("error", no);
      ok(server.address().port);
    });
  });
}

let port = opts.port;
for (;;) {
  try {
    port = await listen(port);
    break;
  } catch (err) {
    if (err.code !== "EADDRINUSE" || opts.fixedPort || port >= opts.port + 20) fail(`${opts.host}:${port}: ${err.message}${opts.fixedPort ? " (pick another with --port)" : ""}`);
    port++;
  }
}

const list = await fleets();
first = await defaultFleet(list);
const hostPart = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
const link = `http://${hostPart}:${port}/?key=${key}`;
const running = list.map((f) => f.name);
console.log(`a12s console ${pkg.version}: ${link}`);
console.log(
  running.length
    ? `  Fleets: ${running.join(", ")} (owner powers, this machine only; Ctrl-C to stop)`
    : "  no running Fleet yet: run a12s up in a Fleet's directory, the console picks it up",
);
if (first && !running.includes(first)) console.log(`  Fleet ${first} isn't running: run a12s up in its directory`);

if (opts.open) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [link]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : ["xdg-open", [link]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // print-only is fine
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
