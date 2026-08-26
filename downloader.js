(function () {
  "use strict";

  const CATEGORY = "clients";
  const ORIGIN = "https://wonderland.ac";
  const LIST_DELAY = 1200;
  const ENTRY_DELAY = 1000;
  const DL_DELAY = 1500;
  const MAX_RETRY = 6;
  const PER_PAGE = 27;
  const SRC_ONLY = true;
  const MAX_PAGES = 0;
  const ADFOC_REF = "http://adfoc.us/8762501000046434";
  const DONE_KEY = "wonderland_done_v1";
  let doneSet = new Set();
  try {
    doneSet = new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"));
  } catch (e) {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function b64(s) {
    return btoa(unescape(encodeURIComponent(s))).replace(/=+$/, "");
  }

  function sanitize(s) {
    return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  }

  function decodeParam(v) {
    try {
      return decodeURIComponent(v.replace(/&amp;/g, "&"));
    } catch (e) {
      return v.replace(/&amp;/g, "&");
    }
  }

  async function wlFetch(url, opts, depth) {
    depth = depth || 0;
    const resp = await fetch(url, Object.assign({ credentials: "same-origin", redirect: "manual" }, opts || {}));
    if ((resp.status >= 300 && resp.status < 400) || resp.type === "opaqueredirect") {
      const loc = resp.headers.get("Location");
      if (loc && depth < 5) {
        const up = loc.replace(/^http:\/\//i, "https://");
        return wlFetch(up, opts, depth + 1);
      }
    }
    return resp;
  }

  async function fetchText(url, depth) {
    depth = depth || 0;
    try {
        const resp = await wlFetch(url, { credentials: "same-origin" });
      if (resp.status === 429) {
        if (depth >= MAX_RETRY) throw new Error("429 exhausted " + url);
        const wait = 2000 * Math.pow(2, depth) + Math.random() * 1500;
        console.warn("[WONDERLAND] 429, backing off " + Math.round(wait) + "ms");
        await sleep(wait);
        return fetchText(url, depth + 1);
      }
      if (!resp.ok) throw new Error("HTTP " + resp.status + " for " + url);
      return await resp.text();
    } catch (e) {
      if (depth >= MAX_RETRY) throw e;
      const wait = 2000 * Math.pow(2, depth) + Math.random() * 1500;
      console.warn("[WONDERLAND] err, retry in " + Math.round(wait) + "ms: " + e.message);
      await sleep(wait);
      return fetchText(url, depth + 1);
    }
  }

  function parseEntries(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = doc.querySelectorAll('a[href*="/archive/entry"]');
    const out = [];
    const seen = {};
    links.forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/[?&]entry=([^&"']+)/);
      if (!m) return;
      const name = decodeParam(m[1]);
      if (!name || seen[name]) return;
      let node = a;
      let tags = [];
      for (let i = 0; i < 6 && node; i++) {
        const t = node.querySelectorAll ? node.querySelectorAll(".title-tag") : [];
        if (t.length) {
          tags = [].slice.call(t).map((s) => s.textContent.trim());
          break;
        }
        node = node.parentElement;
      }
      seen[name] = true;
      out.push({ name: name, tags: tags });
    });
    return out;
  }

  function parseAssets(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = doc.querySelectorAll('a[href*="/archive/download"]');
    const out = [];
    const seen = {};
    links.forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/[?&]asset=([^&"']+)/);
      if (!m) return;
      const asset = decodeParam(m[1]);
      if (!asset || seen[asset]) return;
      let node = a;
      let tags = [];
      for (let i = 0; i < 8 && node; i++) {
        const t = node.querySelectorAll ? node.querySelectorAll(".title-tag") : [];
        if (t.length) {
          tags = [].slice.call(t).map((s) => s.textContent.trim());
          break;
        }
        node = node.parentElement;
      }
      const tagStr = tags.join(" ").toUpperCase();
      let isSrc;
      if (tags.length) {
        isSrc = tags.some((t) => t.toUpperCase() === "SRC");
      } else {
        isSrc = asset.toUpperCase().includes("SRC");
      }
      if (SRC_ONLY && !isSrc) return;
      const tagUp = tags.map((t) => t.toUpperCase());
      let status = "SAFE";
      let gated = false;
      if (tagUp.some((t) => t.includes("INFECTED"))) { status = "INFECTED"; gated = true; }
      else if (tagUp.some((t) => t.includes("POSSIBLY"))) { status = "POSSIBLY"; gated = true; }
      else if (tagUp.some((t) => t.includes("LEAK"))) { status = "LEAK"; gated = true; }
      else if (tagUp.some((t) => t.includes("UNSAFE"))) { status = "UNSAFE"; gated = true; }
      seen[asset] = true;
      out.push({ asset: asset, status: status, gated: gated });
    });
    return out;
  }

  function apiUrl(entry, asset) {
    return (
      ORIGIN +
      "/archive/api/download?category=" +
      b64(CATEGORY) +
      "&entry=" +
      b64(entry) +
      "&asset=" +
      b64(asset) +
      "&encode=true"
    );
  }

  function bufIsHtml(buf) {
    const h = new Uint8Array(buf.slice(0, 16));
    for (let i = 0; i < h.length; i++) {
      const c = h[i];
      if (c === 0x3c && (h[i + 1] === 0x21 || h[i + 1] === 0x68 || h[i + 1] === 0x48)) return true;
      if (c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x20) break;
    }
    return false;
  }

  function backoff(attempt) {
    return 2000 * Math.pow(2, attempt) + Math.random() * 1500;
  }

  async function tryGetFile(url, maxRetry, opts) {
    const baseOpts = Object.assign({ credentials: "same-origin", redirect: "follow" }, opts || {});
    for (let i = 0; i < maxRetry; i++) {
      try {
        const resp = await wlFetch(url, baseOpts);
        if (resp.status === 429) {
          console.warn("[WONDERLAND] 429, backoff " + Math.round(backoff(i)) + "ms");
          await sleep(backoff(i));
          continue;
        }
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        if (buf.byteLength === 0) {
          await sleep(backoff(i));
          continue;
        }
        if (bufIsHtml(buf)) {
          if (i < maxRetry - 1) {
            await sleep(backoff(i));
            continue;
          }
          return null;
        }
        return buf;
      } catch (e) {
        console.warn("[WONDERLAND] fetch err, backoff " + Math.round(backoff(i)) + "ms: " + e.message);
        await sleep(backoff(i));
      }
    }
    return null;
  }

  function extFor(buf, asset) {
    const head = new Uint8Array(buf.slice(0, 4));
    let ext = "";
    const dotIdx = asset.lastIndexOf(".");
    if (dotIdx > -1 && dotIdx < asset.length - 1 && asset.slice(dotIdx).length <= 5) {
      ext = asset.slice(dotIdx).replace(/[^.a-z0-9]/gi, "");
    }
    if (!ext) {
      if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05)) ext = ".zip";
      else if (head[0] === 0x1f && head[1] === 0x8b) ext = ".gz";
      else if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x50) ext = ".pdf";
      else if (head[0] === 0x4d && head[1] === 0x5a) ext = ".exe";
    }
    return ext;
  }

  async function getAdfocuReferer(entry, asset, status) {
    const url =
      ORIGIN +
      "/archive/getLink?category=" +
      CATEGORY +
      "&entry=" +
      encodeURIComponent(entry) +
      "&asset=" +
      encodeURIComponent(asset) +
      "&type=DOWNLOAD&status=" +
      (status || "POSSIBLY");
    for (let i = 0; i < 3; i++) {
      try {
        const resp = await fetch(url, { credentials: "same-origin", redirect: "manual" });
        const loc = resp.headers.get("Location") || "";
        let m = loc.match(/adfoc\.us\/(\d+)/);
        if (m) return "http://adfoc.us/" + m[1];
        if (resp.status === 200) {
          const t = await resp.text();
          m = t.match(/adfoc\.us\/(\d+)/);
          if (m) return "http://adfoc.us/" + m[1];
        }
      } catch (e) {
        console.warn("[WONDERLAND] getLink referer err", e);
      }
      await sleep(1000);
    }
    return null;
  }

  async function download(entry, asset, item) {
    const key = entry + "||" + asset;
    if (doneSet.has(key)) {
      console.warn("[WONDERLAND] SKIP already downloaded: " + entry + " / " + asset);
      return true;
    }
    let buf = null;
    if (item && item.gated) {
      console.warn("[WONDERLAND] GATED -> api/download with adfoc.us referer: " + entry + " / " + asset);
      buf = await tryGetFile(apiUrl(entry, asset), 2, {
        referrer: ADFOC_REF,
        referrerPolicy: "unsafe-url",
      });
      if (!buf) {
        const ref = await getAdfocuReferer(entry, asset, item.status);
        if (ref) {
          buf = await tryGetFile(apiUrl(entry, asset), MAX_RETRY, {
            referrer: ref,
            referrerPolicy: "unsafe-url",
          });
        }
      }
    } else {
      buf = await tryGetFile(apiUrl(entry, asset), MAX_RETRY);
    }
    if (!buf) {
      console.warn("GAVE UP (html/rate/empty)", entry, asset);
      return false;
    }
    const ext = extFor(buf, asset);
    const blob = new Blob([buf]);
    const fname = sanitize(entry) + "__" + sanitize(asset) + ext;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    doneSet.add(key);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify(Array.from(doneSet)));
    } catch (e) {}
    return true;
  }

  function isInterstitial(html) {
    const h = (html || "").toLowerCase();
    return (
      h.indexOf("just a moment") !== -1 ||
      h.indexOf("verify you are human") !== -1 ||
      h.indexOf("attention required") !== -1 ||
      h.indexOf("cf-mitigated") !== -1 ||
      h.indexOf("why am i seeing") !== -1
    );
  }

  async function main() {
    console.log("[WONDERLAND] Enumerating entries (SRC_ONLY=" + SRC_ONLY + ")... resuming with " + doneSet.size + " already downloaded");
    const entries = [];
    let page = 1;
    while (true) {
      if (MAX_PAGES > 0 && page > MAX_PAGES) break;
      const url =
        ORIGIN +
        "/archive/entries?category=" +
        CATEGORY +
        "&page=" +
        page +
        "&perPage=" +
        PER_PAGE +
        "&filters=eyJzb3J0IjoiYWxwaGFiZXRpY2FsIiwiZmlsdGVycyI6e319&search=";
      let html = null;
      let es = [];
      let tries = 0;
      while (tries < 3) {
        try {
          html = await fetchText(url);
        } catch (e) {
          console.warn("[WONDERLAND] listing fetch failed p" + page, e);
          break;
        }
        if (isInterstitial(html)) {
          console.warn("[WONDERLAND] listing interstitial, retry p" + page);
          await sleep(2000 * Math.pow(2, tries) + 1000);
          tries++;
          continue;
        }
        es = parseEntries(html);
        if (es.length > 0) break;
        tries++;
        await sleep(1500);
      }
      if (es.length === 0) break;
      for (const e of es) {
        const t = e.tags.join(" ").toUpperCase();
        const pureBinary = t.includes("BINARY") && !t.includes("SRC") && !t.includes("MULTIPLE");
        if (pureBinary) continue;
        entries.push(e);
      }
      console.log(
        "[WONDERLAND] page " + page + ": +" + es.length + " entries (queued " + entries.length + ")"
      );
      page++;
      await sleep(LIST_DELAY);
    }

    console.log("[WONDERLAND] Entries to scan: " + entries.length + ". Downloading SRC assets...");
    const manifest = [];
    const gatedList = [];
    let done = 0;
    let files = 0;

    for (const entry of entries) {
      const ep =
        ORIGIN +
        "/archive/entry?category=" +
        CATEGORY +
        "&entry=" +
        encodeURIComponent(entry.name);
      let assets = [];
      let html = null;
      let tries = 0;
      let ok = false;
      while (tries < 3) {
        try {
          html = await fetchText(ep);
          ok = true;
        } catch (e) {
          console.warn("[WONDERLAND] entry fetch failed: " + entry.name, e);
          break;
        }
        if (isInterstitial(html)) {
          console.warn("[WONDERLAND] entry interstitial, retry: " + entry.name);
          await sleep(2000 * Math.pow(2, tries) + 1000);
          tries++;
          ok = false;
          continue;
        }
        break;
      }
      if (ok && html) assets = parseAssets(html);
      manifest.push({ entry: entry.name, assets: assets.map((a) => a.asset) });
      for (const asset of assets) {
        const res = await download(entry.name, asset.asset, asset);
        if (res === true) {
          files++;
        } else {
          gatedList.push({
            entry: entry.name,
            asset: asset.asset,
            direct: apiUrl(entry.name, asset.asset),
            landing:
              ORIGIN +
              "/archive/download?category=" +
              CATEGORY +
              "&entry=" +
              encodeURIComponent(entry.name) +
              "&asset=" +
              encodeURIComponent(asset.asset),
            reason: "gated-fetch-failed",
          });
        }
        done++;
        document.title = "[WL] " + done + " src assets | " + entry.name;
        await sleep(DL_DELAY);
      }
      await sleep(ENTRY_DELAY);
    }

    const mblob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const ma = document.createElement("a");
    ma.href = URL.createObjectURL(mblob);
    ma.download = "wonderland_src_manifest.json";
    document.body.appendChild(ma);
    ma.click();
    ma.remove();

    const gblob = new Blob([JSON.stringify(gatedList, null, 2)], { type: "application/json" });
    const ga = document.createElement("a");
    ga.href = URL.createObjectURL(gblob);
    ga.download = "wonderland_gated_src.json";
    document.body.appendChild(ga);
    ga.click();
    ga.remove();

    console.log(
      "[WONDERLAND] DONE. Entries scanned: " +
        entries.length +
        ", SRC files downloaded: " +
        files +
        ", gated SRC still needing manual: " +
        gatedList.length
    );
    document.title = "[WL] DONE " + files + " src files, " + gatedList.length + " manual";
  }

  main();
})();
