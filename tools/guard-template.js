/*
 * yt-guard __GUARD_VERSION__ — защитная обёртка вокруг скрипта Maasea/sgmodule.
 *
 * Оригинал:      __UPSTREAM_REPO__ @ __UPSTREAM_COMMIT__ : __UPSTREAM_PATH__
 * sha256 оригинала: __UPSTREAM_SHA256__
 * Лицензия: Apache-2.0 (см. LICENSE в репозитории).
 *
 * Что изменено (Apache-2.0, §4b): код оригинала вставлен ниже байт-в-байт,
 * но выполняется внутри этой обёртки. Обёртка:
 *   1. запускает скрипт только на хостах из [MITM] модуля;
 *   2. запрещает любые сетевые обращения ($httpClient, $task, fetch,
 *      XMLHttpRequest, WebSocket, sendBeacon…), редиректы ($done({url}))
 *      и заголовки Location на хосты вне списка: __ALLOW_LIST__
 *   3. если оригинал пытается отправить запрос на внешний ретранслятор
 *      (Cloudflare Worker автора), отвечает пустым ответом и стирает ключ
 *      Onesie — приложение переходит на обычный /youtubei/v1/player,
 *      который чистится локально на телефоне.
 *
 * Файл собран tools/build.mjs. Не редактируйте его вручную — правьте
 * tools/guard-template.js и пересобирайте.
 */
;(function (G) {
  var CFG = __CFG_JSON__;

  // ---------- журнал ----------
  function report(kind, host) {
    try { console.log("[yt-guard] заблокировано: " + kind + " -> " + host); } catch (_) {}
    try { if (G.__YT_GUARD_EVENTS__) G.__YT_GUARD_EVENTS__.push({ kind: kind, host: host }); } catch (_) {}
  }
  function clip(v) { return String(v == null ? "" : v).slice(0, 120); }

  // ---------- проверка хостов ----------
  // Возвращает имя хоста в нижнем регистре или null, если адрес непонятен.
  // Всё странное (IPv6, экранирование, мусор) считается запрещённым.
  function hostOf(u) {
    if (u && typeof u === "object" && typeof u.href === "string") u = u.href;
    if (typeof u !== "string") return null;
    var h = null;
    try { if (typeof URL === "function") h = new URL(u).hostname; } catch (_) { h = null; }
    if (h === null) {
      var m = /^[a-z][a-z0-9+.\-]*:\/\/([^\/\\?#]*)/i.exec(u);
      if (!m) return null;
      h = m[1];
      var at = h.lastIndexOf("@");
      if (at >= 0) h = h.slice(at + 1);
      h = h.replace(/:\d*$/, "");
    }
    h = String(h).toLowerCase().replace(/\.$/, "");
    if (!h || /[^a-z0-9.\-]/.test(h)) return null;
    return h;
  }

  // Хост совпадает с доменом из списка или является его поддоменом.
  function inList(h, list) {
    if (!h) return false;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (h === d) return true;
      if (h.length > d.length && h.slice(-(d.length + 1)) === "." + d) return true;
    }
    return false;
  }

  function allowedUrl(u) { return inList(hostOf(u), CFG.allow); }

  // Location может быть относительным — тогда он остаётся на том же
  // (уже разрешённом) хосте.
  function allowedLocation(v) {
    v = String(v == null ? "" : v).trim();
    if (/^\/\//.test(v)) return allowedUrl("https:" + v);
    if (/^[a-z][a-z0-9+.\-]*:/i.test(v)) return allowedUrl(v);
    return !/^\\/.test(v);
  }

  // ---------- запрос, на котором нас запустили ----------
  var reqUrl = "", reqHeaders = {};
  try {
    if (typeof $request !== "undefined" && $request) {
      reqUrl = String($request.url || "");
      reqHeaders = $request.headers || {};
    }
  } catch (_) {}

  var realDone = typeof $done === "function" ? $done : null;

  // Скрипт работает только на хостах из [MITM] модуля. Шаблон [Script] и так
  // это гарантирует, но если MITM когда-нибудь окажется шире — не рискуем.
  if (!CFG.runOn.length || !inList(hostOf(reqUrl), CFG.runOn)) {
    report("запуск вне MITM-хостов", hostOf(reqUrl) || clip(reqUrl));
    if (realDone) realDone({});
    return;
  }

  // ---------- запасной путь вместо ретранслятора ----------
  // Удаляем закешированный ключ Onesie: без него приложение запросит
  // /youtubei/v1/player, а этот ответ скрипт чистит прямо на телефоне.
  function forgetOnesieKey() {
    try {
      var o = CFG.onesie;
      if (!o || typeof $persistentStore === "undefined") return;
      var raw = $persistentStore.read(o.storeKey);
      if (!raw) return;
      var cfg = JSON.parse(raw);
      var ua = reqHeaders["user-agent"] != null ? reqHeaders["user-agent"] : reqHeaders["User-Agent"];
      var key = String(ua || "").indexOf("music") >= 0 ? o.musicKey : o.videoKey;
      if (cfg && cfg[key]) {
        delete cfg[key];
        $persistentStore.write(JSON.stringify(cfg), o.storeKey);
      }
    } catch (_) {}
  }

  function fallback() {
    if (/\/initplayback/.test(reqUrl)) {
      forgetOnesieKey();
      return { response: { status: 200, headers: { "Content-Type": "text/plain" }, body: new Uint8Array(0) } };
    }
    return {}; // пропустить исходный запрос/ответ без изменений
  }

  // ---------- подмена API ----------
  var saved = {}; // исходные глобальные значения, чтобы вернуть их после $done

  function guardedDone(obj) {
    restoreGlobals();
    if (!realDone) return;
    var bad = null;
    try {
      if (obj && typeof obj === "object") {
        if (obj.url != null && !allowedUrl(obj.url)) bad = ["$done.url", hostOf(obj.url) || clip(obj.url)];
        var sets = [obj.headers, obj.response && typeof obj.response === "object" ? obj.response.headers : null];
        for (var s = 0; s < sets.length && !bad; s++) {
          var hs = sets[s];
          if (!hs || typeof hs !== "object") continue;
          for (var k in hs) {
            if (/^location$/i.test(k) && !allowedLocation(hs[k])) {
              bad = ["заголовок Location", hostOf(String(hs[k])) || clip(hs[k])];
              break;
            }
          }
        }
      }
    } catch (e) {
      bad = ["ошибка проверки", clip(e)];
    }
    if (bad) {
      report(bad[0], bad[1]);
      return realDone(fallback());
    }
    return realDone.apply(this, arguments);
  }

  function guardHttpClient(hc) {
    if (!hc) return hc;
    var out = {};
    ["get", "post", "put", "delete", "head", "options", "patch"].forEach(function (m) {
      if (typeof hc[m] !== "function") return;
      out[m] = function (opts, cb) {
        var u = typeof opts === "string" ? opts : (opts && opts.url);
        if (!allowedUrl(u)) {
          report("$httpClient." + m, hostOf(u) || clip(u));
          if (typeof cb === "function") { try { cb("заблокировано yt-guard", null, null); } catch (_) {} }
          return;
        }
        return hc[m].apply(hc, arguments);
      };
    });
    return out;
  }

  function guardTask(t) {
    if (!t) return t;
    return {
      fetch: function (req) {
        var u = req && req.url;
        if (!allowedUrl(u)) {
          report("$task.fetch", hostOf(u) || clip(u));
          return Promise.reject({ error: "заблокировано yt-guard" });
        }
        return t.fetch(req);
      }
    };
  }

  function guardFetch(f) {
    if (typeof f !== "function") return undefined;
    return function (input, init) {
      var u = typeof input === "string" ? input : (input && (input.url || input.href));
      if (!allowedUrl(u)) {
        report("fetch", hostOf(u) || clip(u));
        return Promise.reject(new TypeError("заблокировано yt-guard"));
      }
      return f(input, init);
    };
  }

  // Эти API скрипту не нужны вовсе — любой вызов запрещён.
  function forbidden(name) {
    return function () {
      report(name, "(любой хост)");
      throw new Error(name + " заблокирован yt-guard");
    };
  }

  function has(name) { try { return typeof G[name] !== "undefined"; } catch (_) { return false; } }

  var API = {
    $done: guardedDone,
    $httpClient: guardHttpClient(has("$httpClient") ? G.$httpClient : undefined),
    $task: guardTask(has("$task") ? G.$task : undefined),
    fetch: guardFetch(has("fetch") ? G.fetch : undefined),
    XMLHttpRequest: has("XMLHttpRequest") ? forbidden("XMLHttpRequest") : undefined,
    WebSocket: has("WebSocket") ? forbidden("WebSocket") : undefined,
    EventSource: has("EventSource") ? forbidden("EventSource") : undefined,
    Image: has("Image") ? forbidden("Image") : undefined,
    importScripts: has("importScripts") ? forbidden("importScripts") : undefined,
    navigator: has("navigator") ? {
      userAgent: G.navigator.userAgent,
      language: G.navigator.language,
      sendBeacon: function () { report("sendBeacon", "(любой хост)"); return false; }
    } : undefined
  };

  // Помимо подмены через параметры функции (см. ниже), подменяем и глобальные
  // значения: так код вида Function("return this")().$httpClient тоже получит
  // защищённую версию. Если движок не даёт перезаписать глобал — ничего
  // страшного, подмена через параметры всё равно действует. При вызове $done
  // всё возвращается как было, чтобы не мешать следующим скриптам.
  function installGlobals() {
    for (var name in API) {
      if (!has(name) || API[name] === undefined) continue;
      try { saved[name] = G[name]; G[name] = API[name]; } catch (_) { delete saved[name]; }
    }
  }
  function restoreGlobals() {
    for (var name in saved) {
      try { G[name] = saved[name]; } catch (_) {}
    }
    saved = {};
  }

  installGlobals();

  (function ($done, $httpClient, $task, fetch, XMLHttpRequest, WebSocket, EventSource, Image, importScripts, navigator) {
/* ===== начало кода Maasea (без изменений) ===== */
__UPSTREAM_CODE__
/* ===== конец кода Maasea ===== */
  })(API.$done, API.$httpClient, API.$task, API.fetch, API.XMLHttpRequest, API.WebSocket,
     API.EventSource, API.Image, API.importScripts, API.navigator);
})(typeof globalThis !== "undefined" ? globalThis : this);
