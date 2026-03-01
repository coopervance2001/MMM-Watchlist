/* eslint-disable no-var */
var NodeHelper = require("node_helper");

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// Returns minutes since midnight in America/New_York for a unix-seconds timestamp
function nyMinutesOfDay(unixSec) {
  var d = new Date(unixSec * 1000);
  var parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(d);

  var hh = 0, mm = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === "hour") hh = parseInt(parts[i].value, 10);
    if (parts[i].type === "minute") mm = parseInt(parts[i].value, 10);
  }
  return hh * 60 + mm;
}

function isRegularSessionET(unixSec) {
  var m = nyMinutesOfDay(unixSec);
  // 09:30–16:00 ET
  return m >= (9 * 60 + 30) && m <= (16 * 60);
}

function downsample(arr, maxPts) {
  if (!arr || arr.length <= maxPts) return arr || [];
  var out = [];
  var step = (arr.length - 1) / (maxPts - 1);
  for (var i = 0; i < maxPts; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

module.exports = NodeHelper.create({
  start: function () {
    this.config = null;
    this.timer = null;
    this.candleCache = new Map(); // symbol -> { at, spark: [] }
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "MMM_WL_CONFIG") {
      this.config = payload || {};
      this.scheduleFetch(true);
      console.log("[MMM-Watchlist] got MMM_WL_CONFIG keys:", Object.keys(payload || {}));
      console.log("[MMM-Watchlist] apiKey present:", !!(payload && payload.apiKey));
    }
  },

  fetchSpark: async function (symbol, apiKey, opts) {
    var cacheMs = (opts && opts.cacheMs) ? opts.cacheMs : (10 * 60 * 1000);
    var pointsMax = (opts && opts.pointsMax) ? opts.pointsMax : 78; // ~5m bars for session
    var resolution = (opts && opts.resolution) ? opts.resolution : 5; // 5-min
    var now = Math.floor(Date.now() / 1000);
  
    var cached = this.candleCache.get(symbol);
    if (cached && (Date.now() - cached.at) < cacheMs) return cached.spark;
  
    // Pull a bit more than a day to be safe with time zones/holidays
    var from = now - (60 * 60 * 36); // 36 hours
  
    var url =
      "https://finnhub.io/api/v1/stock/candle?symbol=" +
      encodeURIComponent(symbol) +
      "&resolution=" + encodeURIComponent(String(resolution)) +
      "&from=" + encodeURIComponent(String(from)) +
      "&to=" + encodeURIComponent(String(now)) +
      "&token=" + encodeURIComponent(apiKey);
  
    var json = await this.fetchJson(url, (this.config && this.config.requestTimeout) ? this.config.requestTimeout : 12000);
  
    // Finnhub returns: { c:[], t:[], s:"ok" }  (c=close, t=unix seconds)
    if (!json || json.s !== "ok" || !Array.isArray(json.c) || !Array.isArray(json.t)) {
      this.candleCache.set(symbol, { at: Date.now(), spark: [] });
      return [];
    }
  
    // Filter to regular session
    var closes = [];
    for (var i = 0; i < json.t.length; i++) {
      var ts = json.t[i];
      if (isRegularSessionET(ts)) {
        var v = json.c[i];
        if (typeof v === "number" && isFinite(v)) closes.push(v);
      }
    }
  
    var spark = downsample(closes, pointsMax);
    this.candleCache.set(symbol, { at: Date.now(), spark: spark });
    return spark;
  },

  scheduleFetch: function (immediate) {
    var self = this;
    if (!self.config) return;
    if (self.timer) clearTimeout(self.timer);

    var delay = immediate ? 0 : (self.config.refreshInterval || 60000);
    if (delay < 15000) delay = 15000; // be nice to free API limits

    self.timer = setTimeout(function () {
      self.fetchAndSend()
        .catch(function (e) {
          self.sendSocketNotification("MMM_WL_ERROR", {
            message: String((e && e.message) ? e.message : e)
          });
        })
        .finally(function () {
          self.scheduleFetch(false);
        });
    }, delay);
  },

  fetchAndSend: async function () {
    var timeoutMs = this.config.requestTimeout || 12000;

    var provider = String(this.config.provider || "finnhub").toLowerCase();
    if (provider !== "finnhub") {
      throw new Error("Provider must be 'finnhub' for this version.");
    }

    var apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error("Missing apiKey in MMM-Watchlist config.");
    }

    var symbols = this.getSymbols();
    if (!symbols.length) {
      this.sendSocketNotification("MMM_WL_DATA", { rows: [] });
      return;
    }

    // Finnhub quote is per-symbol. Fetch sequentially to reduce rate-limit risk.
    var rows = [];
    for (var i = 0; i < symbols.length; i++) {
      var sym = symbols[i];

      var url =
        "https://finnhub.io/api/v1/quote?symbol=" +
        encodeURIComponent(sym) +
        "&token=" +
        encodeURIComponent(apiKey);

      var q = await this.fetchJson(url, timeoutMs);

      // Finnhub fields:
      // c = current, pc = previous close
      var current = (q && typeof q.c === "number") ? q.c : null;
      var prevClose = (q && typeof q.pc === "number") ? q.pc : null;

      var change = (current != null && prevClose != null) ? (current - prevClose) : null;
      var changePercent =
        (current != null && prevClose != null && prevClose !== 0)
          ? ((change / prevClose) * 100)
          : null;

      rows.push({
        symbol: sym,
        currentPrice: current,
        previousClose: prevClose,
        change: change,
        changePercent: changePercent
      });
      if (sym === "AAPL") console.log("[MMM-Watchlist] sample row:", rows[rows.length - 1]);
    }

    console.log("[MMM-Watchlist] sending rows:", rows.length);
    // Sparklines (limit to avoid rate limits)
    var sparkCfg = this.config.sparkline || {};
    var doSpark = !!sparkCfg.enabled;
    var limit = clamp(Number(sparkCfg.limit || 8), 0, 30);

    if (doSpark) {
      for (var k = 0; k < rows.length && k < limit; k++) {
        var s = rows[k].symbol;
        rows[k].spark = await this.fetchSpark(s, apiKey, {
          cacheMs: sparkCfg.cacheMs || (10 * 60 * 1000),
          pointsMax: sparkCfg.pointsMax || 78,
          resolution: sparkCfg.resolution || 5
        });
        
        if (k === 0) {
          console.log("[MMM-Watchlist] spark pts:", (rows[k].spark || []).length);
        }
      }
    } else {
      for (var m = 0; m < rows.length; m++) rows[m].spark = [];
    }
    this.sendSocketNotification("MMM_WL_DATA", { rows: rows });
  },

  getSymbols: function () {
    var direct = Array.isArray(this.config.symbols) ? this.config.symbols : [];
    var seen = {};
    var cleaned = [];

    for (var i = 0; i < direct.length; i++) {
      var sym = String(direct[i] || "").trim().toUpperCase();
      if (!sym || seen[sym]) continue;
      seen[sym] = true;
      cleaned.push(sym);
      if (cleaned.length >= 30) break;
    }

    return cleaned;
  },

  fetchJson: async function (url, timeoutMs) {
    var text = await this.fetchText(url, timeoutMs);
    return JSON.parse(text);
  },

  fetchText: async function (url, timeoutMs) {
    var controller = new AbortController();
    var id = setTimeout(function () { controller.abort(); }, timeoutMs || 12000);

    try {
      var res = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error("HTTP " + res.status + " fetching " + url);
      }

      return await res.text();
    } finally {
      clearTimeout(id);
    }
  }
});
