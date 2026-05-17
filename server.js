/**
 * Pull Proxy with In-Memory Cache
 * Rewritten from Cloudflare Worker → Node.js/Express for Render
 *
 * Origin: byod.baylib.top
 *
 * First request for any URL hits the origin and caches the response.
 * Subsequent requests are served from the in-process LRU cache.
 *
 * Deploy on Render as a "Web Service" (Node, free tier).
 * Set environment variable PORT if needed (Render sets it automatically).
 */

import express from "express";
import fetch, { Headers, Request } from "node-fetch";
import { parse as parseHtml } from "node-html-parser";

// ── Config ────────────────────────────────────────────────────────────────────

const ORIGIN_HOST = "byod.baylib.top";

const META_TITLE       = "IXL | Math, Language Arts, Science, Social Studies, and Spanish";
const META_DESCRIPTION = "IXL is the world's most popular subscription-based learning site for K–12. Used by over 18 million students, IXL provides personalized learning in more than 17,000 topics, covering math, language arts, science, social studies, and Spanish. Interactive questions, awards, and certificates keep kids motivated as they master skills.";
const META_OG_TITLE    = "IXL | Math, Language Arts, Science, Social Studies, and Spanish";
const META_OG_DESC     = "IXL is the world's most popular subscription-based learning site for K–12. Used by over 18 million students, IXL provides personalized learning in more than 17,000 topics, covering math, language arts, science, social studies, and Spanish. Interactive questions, awards, and certificates keep kids motivated as they master skills.";


const STRIP_REQUEST_HEADERS = new Set([
  "cf-connecting-ip", "cf-ipcountry", "cf-ray",
  "cf-visitor", "x-forwarded-for", "x-real-ip",
  "host",                     // we set our own
]);
 
const STRIP_RESPONSE_HEADERS = new Set([
  "alt-svc", "server", "x-powered-by",
  "content-encoding",         // we decode fully before caching
  "content-length",           // length changes after HTML rewriting
  "transfer-encoding",
]);
 
const DEFAULT_TTL = 86400;              // 1 day  (seconds)
const HTML_TTL    = 3600;              // 1 hour
const ASSET_TTL   = 60 * 60 * 24 * 30; // 30 days
 
// ── Simple in-memory LRU cache ────────────────────────────────────────────────
// Stores { body: Buffer, headers: Object, status: number, expiresAt: number }
 
const MAX_CACHE_ENTRIES = 500;         // tune to your Render instance RAM
const cache = new Map();
 
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // LRU: move to end
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}
 
function cacheSet(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    // Evict oldest (first inserted)
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, value);
}
 
// ── Helpers ───────────────────────────────────────────────────────────────────
 
function normalisedCacheKey(rawUrl) {
  const u = new URL(rawUrl);
  u.hostname = ORIGIN_HOST;
  u.protocol = "https:";
  u.port = "";
  return u.toString();
}
 
function isStaticAsset(contentType = "") {
  return [
    "image/", "font/", "audio/", "video/",
    "application/javascript", "text/javascript",
    "text/css", "application/wasm",
  ].some(t => contentType.startsWith(t));
}
 
function chooseTtl(contentType = "") {
  if (contentType.includes("text/html")) return HTML_TTL;
  if (isStaticAsset(contentType)) return ASSET_TTL;
  return DEFAULT_TTL;
}
 
function buildOriginHeaders(reqHeaders, incomingHost) {
  const out = {};
  for (const [key, value] of Object.entries(reqHeaders)) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  out["host"] = ORIGIN_HOST;
  out["x-forwarded-host"] = incomingHost ?? ORIGIN_HOST;
  out["accept-encoding"] = "identity"; // avoid compressed responses
  return out;
}
 
function filterResponseHeaders(rawHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out[key] = value;
    }
  }
  return out;
}
 
/**
 * Rewrite URLs in an attribute value so any absolute reference to the origin
 * host is replaced with a proxy-relative path, and absolute paths are kept
 * as-is (the browser will resolve them against the proxy host).
 */
function rewriteUrl(value) {
  if (!value) return value;
  try {
    // Absolute URL pointing at the origin → strip host, keep path
    const u = new URL(value);
    if (u.hostname === ORIGIN_HOST) {
      return u.pathname + u.search + u.hash;
    }
    // External URL — leave alone
    return value;
  } catch {
    // Relative URL — leave alone (browser resolves against proxy host)
    return value;
  }
}
 
/** Rewrite HTML: meta tags + all asset/link URLs → proxy-relative paths */
function rewriteHtml(html, isIndex) {
  const root = parseHtml(html, { comment: false, blockTextElements: {
    script: true, style: true, pre: true,
  }});
 
  // ── Rewrite all URL attributes ──────────────────────────────────────────
  const urlAttrs = {
    "a":      ["href"],
    "link":   ["href"],
    "script": ["src"],
    "img":    ["src", "srcset"],
    "source": ["src", "srcset"],
    "iframe": ["src"],
    "form":   ["action"],
    "video":  ["src", "poster"],
    "audio":  ["src"],
    "use":    ["href", "xlink:href"],
  };
 
  for (const [tag, attrs] of Object.entries(urlAttrs)) {
    root.querySelectorAll(tag).forEach(el => {
      for (const attr of attrs) {
        const val = el.getAttribute(attr);
        if (!val) continue;
        if (attr === "srcset") {
          // srcset is comma-separated "url [descriptor]" pairs
          const rewritten = val.split(",").map(part => {
            const [url, ...rest] = part.trim().split(/\s+/);
            return [rewriteUrl(url), ...rest].join(" ");
          }).join(", ");
          el.setAttribute(attr, rewritten);
        } else {
          el.setAttribute(attr, rewriteUrl(val));
        }
      }
    });
  }
 
  // ── Rewrite CSS url() inside <style> blocks ─────────────────────────────
  root.querySelectorAll("style").forEach(el => {
    const rewritten = el.innerHTML.replace(
      /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,
      (_, quote, url) => `url(${quote}${rewriteUrl(url)}${quote})`
    );
    el.set_content(rewritten, { html: true });
  });
 
  // ── Meta rewrites (index page only) ─────────────────────────────────────
  if (isIndex) {
    const titleEl = root.querySelector("title");
    if (titleEl) titleEl.set_content(META_TITLE);
 
    const ours = new Set([
      "title", "description",
      "og:type", "og:title", "og:description",
      "twitter:card", "twitter:title", "twitter:description",
    ]);
    root.querySelectorAll("meta").forEach(el => {
      const name     = (el.getAttribute("name")     ?? "").toLowerCase();
      const property = (el.getAttribute("property") ?? "").toLowerCase();
      if (ours.has(name) || ours.has(property)) el.remove();
    });
 
    const head = root.querySelector("head");
    if (head) {
      const inject = `
<title>${META_TITLE}</title>
<meta name="description" content="${META_DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:title" content="${META_OG_TITLE}">
<meta property="og:description" content="${META_OG_DESC}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${META_OG_TITLE}">
<meta name="twitter:description" content="${META_OG_DESC}">`.trim();
      head.set_content(inject + head.innerHTML);
    }
  }
 
  return root.toString();
}
 
// ── Proxy + cache logic ───────────────────────────────────────────────────────
 
async function handleRequest(req, res) {
  const isCacheable = ["GET", "HEAD"].includes(req.method);
  const incomingUrl = `https://${req.headers.host}${req.url}`;
  const cacheKey    = normalisedCacheKey(incomingUrl);
 
  // ── 1. Cache hit ──────────────────────────────────────────────────────────
  if (isCacheable) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      res.set({ ...hit.headers, "x-cache": "HIT" });
      res.status(hit.status);
      return res.end(hit.body);
    }
  }
 
  // ── 2. Fetch from origin ──────────────────────────────────────────────────
  const originUrl = new URL(incomingUrl);
  originUrl.hostname = ORIGIN_HOST;
  originUrl.protocol = "https:";
  originUrl.port = "";
 
  let originRes;
  try {
    originRes = await fetch(originUrl.toString(), {
      method:  req.method,
      headers: buildOriginHeaders(req.headers, req.headers.host),
      // stream body for non-GET methods
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req,
      redirect: "follow",
    });
  } catch (err) {
    res.status(502).send(`Proxy error: ${err.message}`);
    return;
  }
 
  const responseHeaders = filterResponseHeaders(
    Object.fromEntries(originRes.headers.entries())
  );
  const contentType = responseHeaders["content-type"] ?? "";
  const status      = originRes.status;
 
  // Read full body into buffer so we can cache + optionally rewrite
  const bodyBuffer = Buffer.from(await originRes.arrayBuffer());
 
  // ── 3. HTML / CSS rewriting ───────────────────────────────────────────────
  let finalBody = bodyBuffer;
  const pathname = new URL(originUrl).pathname;
  const isIndex  = pathname === "/" || pathname === "/index.html";
 
  if (contentType.includes("text/html")) {
    const rewritten = rewriteHtml(bodyBuffer.toString("utf8"), isIndex);
    finalBody = Buffer.from(rewritten, "utf8");
  } else if (contentType.includes("text/css")) {
    const rewritten = finalBody.toString("utf8").replace(
      /url\(\s*(['"]?)([^)'"]+)\1\s*\)/g,
      (_, quote, url) => `url(${quote}${rewriteUrl(url)}${quote})`
    );
    finalBody = Buffer.from(rewritten, "utf8");
  }
 
  // ── 4. Cache successful responses ─────────────────────────────────────────
  const cacheable = isCacheable && (originRes.ok || [301, 302].includes(status));
  if (cacheable) {
    const ttl = chooseTtl(contentType);
    const outHeaders = {
      ...responseHeaders,
      "cache-control": `public, max-age=${ttl}`,
      "x-cache": "MISS",
    };
    cacheSet(cacheKey, {
      body:      finalBody,
      headers:   outHeaders,
      status,
      expiresAt: Date.now() + ttl * 1000,
    });
    res.set(outHeaders);
  } else {
    res.set({ ...responseHeaders, "x-cache": "MISS" });
  }
 
  res.status(status);
  res.end(finalBody);
}
 
// ── Express app ───────────────────────────────────────────────────────────────
 
const app = express();
 
// Disable Express's default body parsing — we stream raw bodies to the origin
app.use((req, res, next) => {
  req.socket.setTimeout(30_000);
  next();
});
 
app.all("*", handleRequest);
 
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
  console.log(`Proxying → https://${ORIGIN_HOST}`);
});
