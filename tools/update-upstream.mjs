#!/usr/bin/env node
// Скачивает файлы Maasea/sgmodule на указанном коммите в папку upstream/
// и записывает их sha256 в upstream.lock.json.
//
//   node tools/update-upstream.mjs <commit-sha>
//
// Ничего не собирает и не публикует: после запуска посмотрите `git diff upstream/`,
// затем выполните `node tools/build.mjs` и `node tools/verify.mjs`.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REPO = "Maasea/sgmodule";
const cfg = JSON.parse(readFileSync(join(ROOT, "tools/config.json"), "utf8"));
const FILES = ["YouTube.Enhance.sgmodule", "LICENSE", ...cfg.scripts];

const commit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("Нужен полный sha коммита (40 символов): node tools/update-upstream.mjs <sha>");
  process.exit(2);
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const lockPath = join(ROOT, "upstream.lock.json");
const old = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : { files: {} };

const meta = await (await fetch(`https://api.github.com/repos/${REPO}/commits/${commit}`)).json();
const commitDate = meta?.commit?.committer?.date;
if (!commitDate) throw new Error(`Коммит ${commit} не найден в ${REPO}`);

const files = {};
for (const f of FILES) {
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = join(ROOT, "upstream", f);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  files[f] = sha256(buf);
  const mark = old.files?.[f] === files[f] ? "без изменений" : "ИЗМЕНИЛСЯ";
  console.log(`${mark.padEnd(13)} ${f}  ${files[f]}`);
}

writeFileSync(lockPath, JSON.stringify({
  repo: `https://github.com/${REPO}`,
  commit,
  commitDate,
  files,
}, null, 2) + "\n");

if (old.files?.["YouTube.Enhance.sgmodule"] && old.files["YouTube.Enhance.sgmodule"] !== files["YouTube.Enhance.sgmodule"]) {
  console.log("\nВнимание: изменился модуль Maasea. Сверьте шаблоны [Script], аргументы и [MITM]");
  console.log("с src/YouTubeAds.sgmodule вручную: git diff upstream/YouTube.Enhance.sgmodule");
}
console.log("\nДальше: git diff upstream/  →  node tools/build.mjs  →  node tools/verify.mjs");
