#!/usr/bin/env node
// Собирает модуль и скрипты из файлов в upstream/ (без сети).
//
//   node tools/build.mjs          — собрать и записать файлы
//   node tools/build.mjs --check  — только проверить, что файлы в репозитории
//                                   совпадают с результатом сборки (для CI)
//
// Шаги:
//   1. сверить upstream/ с upstream.lock.json (sha256);
//   2. обернуть каждый скрипт Maasea в tools/guard-template.js;
//   3. подставить ссылки на скрипты (закреплённые за тегом version) в
//      src/YouTubeAds.sgmodule и записать YouTubeAds.sgmodule;
//   4. скопировать LICENSE оригинала.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CHECK = process.argv.includes("--check");

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const read = (p) => readFileSync(join(ROOT, p));
const fail = (msg) => { console.error(`build: ${msg}`); process.exit(3); };

export function loadInputs() {
  const cfg = JSON.parse(read("tools/config.json"));
  const lock = JSON.parse(read("upstream.lock.json"));
  for (const [f, want] of Object.entries(lock.files)) {
    const p = join("upstream", f);
    if (!existsSync(join(ROOT, p))) fail(`нет файла ${p}`);
    const got = sha256(read(p));
    if (got !== want) fail(`${p}: sha256 ${got} не совпадает с upstream.lock.json (${want})`);
  }
  for (const s of cfg.scripts) if (!lock.files[s]) fail(`${s} нет в upstream.lock.json`);
  return { cfg, lock, template: read("tools/guard-template.js").toString("utf8") };
}

// Хосты из строки "hostname = %APPEND% *.a.com, b.com" → ["a.com", "b.com"].
// *.a.com превращается в a.com: проверка в обёртке и так пропускает поддомены.
export function mitmHosts(moduleText) {
  const section = (moduleText.match(/^\[MITM\]([\s\S]*?)(?=^\[|(?![\s\S]))/m) || [, ""])[1];
  const m = /^\s*hostname\s*=\s*(.*)$/im.exec(section);
  if (!m) return [];
  return m[1].replace(/%APPEND%|%INSERT%/g, "").split(",")
    .map((s) => s.trim().replace(/^\*\./, ""))
    .filter((s) => s && !s.startsWith("-"));
}

export function wrap(template, vars, code) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`__${k}__`, () => v);
  // функция-заменитель: в коде оригинала полно `$`, их нельзя интерпретировать
  return out.replace("__UPSTREAM_CODE__", () => code.replace(/\s*$/, ""));
}

export function build() {
  const { cfg, lock, template } = loadInputs();
  const { owner, repo } = cfg.github;
  const moduleTpl = read(cfg.module.template).toString("utf8");
  const runOn = mitmHosts(moduleTpl);
  if (!runOn.length) fail("в [MITM] шаблона модуля нет хостов — обёртка не будет запускаться");

  const out = {};
  for (const path of cfg.scripts) {
    const code = read(join("upstream", path)).toString("utf8");
    const guardCfg = { allow: cfg.allowedHosts, runOn, onesie: cfg.onesieCache };
    out[path] = wrap(template, {
      GUARD_VERSION: cfg.guardVersion,
      UPSTREAM_REPO: lock.repo,
      UPSTREAM_COMMIT: lock.commit,
      UPSTREAM_PATH: path,
      UPSTREAM_SHA256: lock.files[path],
      ALLOW_LIST: cfg.allowedHosts.join(", "),
      CFG_JSON: JSON.stringify(guardCfg),
    }, code);
  }

  let mod = moduleTpl
    .replaceAll("{{version}}", cfg.version)
    .replaceAll("{{owner}}", owner)
    .replaceAll("{{repo}}", repo)
    .replaceAll("{{upstream_commit}}", lock.commit)
    .replaceAll("{{allow_list}}", cfg.allowedHosts.join(", "))
    .replace(/\{\{script:([^}]+)\}\}/g, (_, p) => {
      if (!out[p]) fail(`шаблон ссылается на ${p}, но его нет в config.scripts`);
      return `https://raw.githubusercontent.com/${owner}/${repo}/${cfg.version}/${p}`;
    });
  const leftover = mod.match(/\{\{(?!\{)[^{}]*\}\}(?!\})/g);
  if (leftover) fail(`в шаблоне модуля остались незаполненные метки: ${leftover.join(", ")}`);
  out[cfg.module.output] = mod;
  out["LICENSE"] = read("upstream/LICENSE").toString("utf8");
  return { cfg, lock, runOn, out };
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const { cfg, out } = build();
  if (cfg.github.owner === "YOUR_GITHUB_USER") {
    console.warn("build: в tools/config.json не указан github.owner — ссылки в модуле будут нерабочими");
  }
  let stale = [];
  for (const [p, content] of Object.entries(out)) {
    const dest = join(ROOT, p);
    const same = existsSync(dest) && readFileSync(dest, "utf8") === content;
    if (CHECK) { if (!same) stale.push(p); continue; }
    if (same) continue;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    console.log(`записан ${p}  sha256=${sha256(content).slice(0, 16)}`);
  }
  if (CHECK && stale.length) fail(`файлы не совпадают со сборкой: ${stale.join(", ")} — запустите node tools/build.mjs`);
  if (CHECK) console.log("build --check: всё совпадает");
}
