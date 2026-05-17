const express = require("express");
const fetch   = require("node-fetch");

const app = express();

// ── Config ────────────────────────────────────────────────────────────────────
const ORIGIN_HOST      = "byod.baylib.top";
const ORIGIN           = `https://${ORIGIN_HOST}`;
const PORT             = process.env.PORT || 3000;

const META_TITLE       = "i-Ready Learning";
const META_DESCRIPTION = "Learn how i-Ready adaptive assessments and personalized instruction helps students achieve their personal best in mathematics and literacy.";
const META_OG_TITLE    = "i-Ready Learning";
const META_OG_DESC     = "Learn how i-Ready adaptive assessments and personalized instruction helps students achieve their personal best in mathematics and literacy.";
// ─────────────────────────────────────────────────────────────────────────────

const META_BLOCK = `<title>${META_TITLE}</title>
<meta name="description" content="${META_DESCRIPTION}">
<meta property="og:type" content="website">
<meta property="og:title" content="${META_OG_TITLE}">
<meta property="og:description" content="${META_OG_DESC}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${META_OG_TITLE}">
<meta name="twitter:description" content="${META_OG_DESC}">`;

// Simple in-memory cache  { url -> { body, contentType, cachedAt } }
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function injectMeta(html) {
  html = html
    .replace(/<title>[^<]*<\/title>/gi, "")
    .replace(/<meta\s+name=["']description["'][^>]*\/?>/gi, "")
    .replace(/<meta\s+property=["']og:[^"']*["'][^>]*\/?>/gi, "")
    .replace(/<meta\s+name=["']twitter:[^"']*["'][^>]*\/?>/gi, "");

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, `$1\n${META_BLOCK}`);
  }
  return META_BLOCK + "\n" + html;
}

app.use(async (req, res) => {
  const targetUrl = ORIGIN + req.url;

  // Check cache
  const cached = cache.get(targetUrl);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    res.setHeader("Content-Type", cached.contentType);
    res.setHeader("X-Cache", "HIT");
    return res.send(cached.body);
  }

  try {
    // Pull from origin
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent":      req.headers["user-agent"]      || "Mozilla/5.0",
        "Accept":          req.headers["accept"]           || "*/*",
        "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
        "Referer":         ORIGIN,
        "Host":            ORIGIN_HOST,
      },
      redirect: "follow",
    });

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const isHTML = contentType.includes("text/html");

    let body;
    if (isHTML) {
      const text = await upstream.text();
      body = injectMeta(text);
    } else {
      body = await upstream.buffer();
    }

    // Cache it
    cache.set(targetUrl, { body, contentType, cachedAt: Date.now() });

    // Evict oldest entries if cache grows too large
    if (cache.size > 500) {
      const oldest = [...cache.entries()]
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
        .slice(0, 100)
        .map(([k]) => k);
      oldest.forEach((k) => cache.delete(k));
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Cache", "MISS");
    res.status(upstream.status).send(body);

  } catch (err) {
    console.error("[pull error]", err.message);
    res.status(502).send("Bad Gateway – could not fetch from origin");
  }
});

app.listen(PORT, () => {
  console.log(`byod pull proxy → ${ORIGIN}  (local :${PORT})`);
});
