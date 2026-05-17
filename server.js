/**
 * Pull Proxy with In-Memory Cache
 * Origin: byod.baylib.top → proxied through Render
 *
 * Every request is proxied. Redirects are intercepted and rewritten
 * so the browser never leaves the proxy host. HTML + CSS get URL
 * rewriting so all asset references stay on the proxy too.
 */

import express from "express";
import fetch   from "node-fetch";
import { parse as parseHtml } from "node-html-parser";

// ── Config ────────────────────────────────────────────────────────────────────

const ORIGIN_HOST = "byod.baylib.top";
const ORIGIN_BASE = `https://${ORIGIN_HOST}`;

const META_TITLE       = "IXL | Math, Language Arts, Science, Social Studies, and Spanish";
const META_DESCRIPTION = "IXL is the world's most popular subscription-based learning site for K–12. Used by over 18 million students, IXL provides personalized learning in more than 17,000 topics, covering math, language arts, science, social studies, and Spanish. Interactive questions, awards, and certificates keep kids motivated as they master skills.";
const META_OG_TITLE    = "IXL | Math, Language Arts, Science, Social Studies, and Spanish";
const META_OG_DESC     = "IXL is the world's most popular subscription-based learning site for K–12. Used by over 18 million students, IXL provides personalized learning in more than 17,000 topics, covering math, language arts, science, social studies, and Spanish. Interactive questions, awards, and certificates keep kids motivated as they master skills.";

const STRIP_REQUEST_HEADERS = new Set([
  "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray",
  "cf-visitor", "x-forwarded-for", "x-real-ip",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "alt-svc", "server", "x-powered-by",
  "content-encoding",   // we decode fully; don't lie to the client
  "content-length",     // changes after rewriting
  "transfer-encoding",
]);

const DEFAULT_TTL = 86_400;
const HTML_TTL    = 3_600;
const ASSET_TTL   = 86_400 * 30;

// ── In-memory LRU cache ───────────────────────────────────────────────────────

const MAX_ENTRIES = 500;
const lru = new Map();   // key → { body, headers, status, expiresAt }

function cacheGet(key) {
  const e = lru.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { lru.delete(key); return null; }
  lru.delete(key); lru.set(key, e);   // move to end (LRU)
  return e;
}

function cacheSet(key, entry) {
  if (lru.size >= MAX_ENTRIES) lru.delete(lru.keys().next().value);
  lru.set(key, entry);
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function cacheKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hostname = ORIGIN_HOST;
    u.protocol = "https:";
    u.port     = "";
    return u.toString();
  } catch { return rawUrl; }
}

/** Rewrite an absolute origin URL → proxy-relative path; leave everything else */
function rewriteUrl(value) {
  if (!value || value.startsWith("data:") || value.startsWith("#")) return value;
  try {
    const u = new URL(value);
    if (u.hostname === ORIGIN_HOST) return u.pathname + u.search + u.hash;
    return value;
  } catch {
    return value;   // already relative
  }
}

function isStaticAsset(ct = "") {
  return ["image/","font/","audio/","video/",
          "application/javascript","text/javascript",
          "text/css","application/wasm"].some(t => ct.startsWith(t));
}

function chooseTtl(ct = "") {
  if (ct.includes("text/html")) return HTML_TTL;
  if (isStaticAsset(ct))        return ASSET_TTL;
  return DEFAULT_TTL;
}

// ── Header helpers ────────────────────────────────────────────────────────────

function buildRequestHeaders(incoming, proxyHost) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  out["host"]             = ORIGIN_HOST;
  out["x-forwarded-host"] = proxyHost ?? ORIGIN_HOST;
  out["accept-encoding"]  = "identity";   // no gzip — we need to read the body
  return out;
}

function filterResponseHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// ── HTML / CSS rewriter ───────────────────────────────────────────────────────

const URL_ATTRS = {
  a:      ["href"],
  link:   ["href"],
  script: ["src"],
  img:    ["src", "srcset"],
  source: ["src", "srcset"],
  iframe: ["src"],
  form:   ["action"],
  video:  ["src", "poster"],
  audio:  ["src"],
  use:    ["href", "xlink:href"],
};

function rewriteSrcset(value) {
  return value.split(",").map(part => {
    const [url, ...rest] = part.trim().split(/\s+/);
    return [rewriteUrl(url), ...rest].join(" ");
  }).join(", ");
}

function rewriteCssUrls(css) {
  return css.replace(
    /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,
    (_, q, u) => `url(${q}${rewriteUrl(u)}${q})`
  );
}

function rewriteHtml(html, isIndex) {
  const root = parseHtml(html, {
    comment: false,
    blockTextElements: { script: true, style: true, pre: true },
  });

  // Rewrite URL attributes on every element
  for (const [tag, attrs] of Object.entries(URL_ATTRS)) {
    root.querySelectorAll(tag).forEach(el => {
      for (const attr of attrs) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        el.setAttribute(attr, attr === "srcset" ? rewriteSrcset(val) : rewriteUrl(val));
      }
    });
  }

  // Rewrite inline <style> url()
  root.querySelectorAll("style").forEach(el => {
    el.set_content(rewriteCssUrls(el.innerHTML), { html: true });
  });

  // Rewrite inline style="" attributes
  root.querySelectorAll("[style]").forEach(el => {
    const s = el.getAttribute("style");
    if (s) el.setAttribute("style", rewriteCssUrls(s));
  });

  // Meta injection (index only)
  if (isIndex) {
    const titleEl = root.querySelector("title");
    if (titleEl) titleEl.set_content(META_TITLE);

    const metaNames = new Set([
      "title","description","og:type","og:title","og:description",
      "twitter:card","twitter:title","twitter:description",
    ]);
    root.querySelectorAll("meta").forEach(el => {
      const name = (el.getAttribute("name") ?? el.getAttribute("property") ?? "").toLowerCase();
      if (metaNames.has(name)) el.remove();
    });

    const head = root.querySelector("head");
    if (head) {
      const inject = [
        `<title>${META_TITLE}</title>`,
        `<meta name="description" content="${META_DESCRIPTION}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:title" content="${META_OG_TITLE}">`,
        `<meta property="og:description" content="${META_OG_DESC}">`,
        `<meta name="twitter:card" content="summary">`,
        `<meta name="twitter:title" content="${META_OG_TITLE}">`,
        `<meta name="twitter:description" content="${META_OG_DESC}">`,
      ].join("\n");
      head.set_content(inject + "\n" + head.innerHTML);
    }
  }

  return root.toString();
}

// ── Core request handler ──────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const method    = req.method;
  const proxyHost = req.headers.host;
  const key       = cacheKey(`https://${proxyHost}${req.url}`);
  const cacheable = ["GET", "HEAD"].includes(method);

  // 1 ── Cache hit ──────────────────────────────────────────────────────────
  if (cacheable) {
    const hit = cacheGet(key);
    if (hit) {
      console.log(`HIT   ${req.url}`);
      res.set({ ...hit.headers, "x-cache": "HIT" });
      return res.status(hit.status).end(hit.body);
    }
  }

  // 2 ── Build origin URL ───────────────────────────────────────────────────
  const originUrl = new URL(`https://${proxyHost}${req.url}`);
  originUrl.hostname = ORIGIN_HOST;
  originUrl.protocol = "https:";
  originUrl.port     = "";

  console.log(`FETCH ${method} ${originUrl}`);

  // 3 ── Fetch with manual redirect so we can rewrite Location headers ──────
  let originRes;
  try {
    originRes = await fetch(originUrl.toString(), {
      method,
      headers:  buildRequestHeaders(req.headers, proxyHost),
      body:     cacheable ? undefined : req,
      redirect: "manual",
    });
  } catch (err) {
    console.error(`ERR   ${err.message}`);
    return res.status(502).send(`Proxy error: ${err.message}`);
  }

  const status          = originRes.status;
  const responseHeaders = filterResponseHeaders(
    Object.fromEntries(originRes.headers.entries())
  );

  // 4 ── Intercept redirects → rewrite Location to stay on proxy ────────────
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = originRes.headers.get("location") ?? "";
    let newLoc = location;
    try {
      const resolved = new URL(location, ORIGIN_BASE);
      if (resolved.hostname === ORIGIN_HOST) {
        newLoc = resolved.pathname + resolved.search + resolved.hash;
      }
    } catch { /* relative already */ }
    console.log(`REDIR ${status} → ${newLoc}`);
    responseHeaders["location"] = newLoc;
    res.set({ ...responseHeaders, "x-cache": "MISS" });
    return res.status(status).end();
  }

  // 5 ── Read full body ─────────────────────────────────────────────────────
  const rawBody = Buffer.from(await originRes.arrayBuffer());
  const ct      = responseHeaders["content-type"] ?? "";
  let body      = rawBody;

  // 6 ── Rewrite text bodies ────────────────────────────────────────────────
  if (ct.includes("text/html")) {
    const isIndex = ["", "/", "/index.html"].includes(originUrl.pathname);
    body = Buffer.from(rewriteHtml(rawBody.toString("utf8"), isIndex), "utf8");
  } else if (ct.includes("text/css")) {
    body = Buffer.from(rewriteCssUrls(rawBody.toString("utf8")), "utf8");
  }
  // All other types (images, fonts, JS, JSON, wasm…) pass through as-is

  // 7 ── Cache and send ─────────────────────────────────────────────────────
  const ttl        = chooseTtl(ct);
  const outHeaders = { ...responseHeaders, "cache-control": `public, max-age=${ttl}`, "x-cache": "MISS" };

  if (cacheable && originRes.ok) {
    cacheSet(key, { body, headers: outHeaders, status, expiresAt: Date.now() + ttl * 1000 });
  }

  res.set(outHeaders).status(status).end(body);
}

// ── Express bootstrap ─────────────────────────────────────────────────────────

const app = express();
app.use((req, _res, next) => { req.socket.setTimeout(30_000); next(); });
app.all("*", handleRequest);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy :${PORT} → ${ORIGIN_BASE}`));
