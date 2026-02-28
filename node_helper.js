const NodeHelper = require("node_helper");

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function jitter(ms, ratio) {
  const r = ratio ?? 0;
  const delta = ms * r;
  const j = (Math.random() * 2 - 1) * delta;
  return Math.max(0, Math.round(ms + j));
}

function nowMs() {
  return Date.now();
}

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.timer = null;

    // Backoff state
    this.failCount = 0;
    this.nextDelayOverrideMs = null;

    // Caches
    this.quotesCache = { at: 0, key: "", rows: [] };
    this.sparkCache = new Map(); // symbol -> { at, data: [] }
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MMM_WL_CONFIG") {
      this.config = payload;
      this.scheduleFetch(true);
    }
  },

  scheduleFetch(immediate = false) {
    if (!this.config) return;
    if (this.timer) clearTimeout(this.timer);

    const base = Math.max(10_000, this.config.refreshInterval || 60_000);

    let delay = immediate ? 0 : base;
    if (!immediate && this.nextDelayOverrideMs != null) {
      delay = Math.max(10_000, this.nextDelayOverrideMs);
      this.nextDelayOverrideMs = null;
    }

    this.timer = setTimeout(async () => {
      try {
        await this.fetchAndSend();
        this.onSuccess();
      } catch (e) {
        this.onFailure(e);
      } finally {
        this.scheduleFetch(false);
      }
    }, delay);
  },

  onSuccess() {
    this.failCount = 0;
    this.nextDelayOverrideMs = null;
  },

  onFailure(err) {
    const msg = err?.message || String(err);
    const is429 = msg.includes("HTTP 429");

    // Notify UI (but don’t spam: send only on first fail or 429)
    if (this.failCount === 0 || is429) {
      this.sendSocketNotification("MMM_WL_ERROR", { message: msg });
    }

    this.failCount += 1;

    const backoffCfg = this.config?.backoff || {};
    if (!backoffCfg.enabled) return;

    const initial = backoffCfg.initialMs ?? 60_000;
    const maxMs = backoffCfg.maxMs ?? 15 * 60_000;
    const mult = backoffCfg.multiplier ?? 2;
    const jit = backoffCfg.jitterRatio ?? 0.15;

    // Exponential backoff, faster ramp if 429
    const factor = is429 ? (mult + 0.5) : mult;
    const exp = initial * Math.pow(factor, this.failCount - 1);
    const next = clamp(exp, initial, maxMs);
    this.nextDelayOverrideMs = jitter(next, jit);
  },

  async fetchAndSend() {
    const timeoutMs = this.config.requestTimeout || 12_000;

    const symbols = await this.getSymbols(timeoutMs);
    if (!symbols.length) {
      this.sendSocketNotification("MMM_WL_DATA", { rows: [] });
      return;
    }

    // Quotes are cheap; spark data is heavier. We’ll batch quotes and selectively pull charts.
    const rows = await this.fetchQuotes(symbols, timeoutMs);

    // Optional sorting (NOT by %)
    const sort = this.config.sort || "none";
    let finalRows = rows;

    if (sort === "symbol") {
      finalRows = [...rows].sort((a, b) => (a.symbol || "").localeCompare(b.symbol || ""));
    } else {
      // preserve user order
      finalRows = [...rows].sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
    }

    // Sparklines
    const sparkCfg = this.config.sparkline || {};
    if (sparkCfg.enabled) {
      const limit = clamp(Number(sparkCfg.limit ?? 12), 0, 50);
      const toFetch = finalRows.slice(0, limit).map(r => r.symbol).filter(Boolean);

      const sparkMap = await this.fetchSparklines(toFetch, sparkCfg, timeoutMs);
      finalRows = finalRows.map(r => ({
        ...r,
        spark: sparkMap.get(r.symbol) || r.spark || []
      }));
    }

    this.sendSocketNotification("MMM_WL_DATA", { rows: finalRows });
  },

  async getSymbols(timeoutMs) {
    const direct = Array.isArray(this.config.symbols) ? this.config.symbols : [];
    const url = (this.config.symbolsUrl || "").trim();

    let symbols = direct;

    if (url) {
      const raw = await this.fetchText(url, timeoutMs);

      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) symbols = parsed;
        else if (parsed && Array.isArray(parsed.symbols)) symbols = parsed.symbols;
        else symbols = direct;
      } catch {
        symbols = raw
          .split(/[\n,]/g)
          .map(s => s.trim())
          .filter(Boolean);
      }
    }

    const cleaned = [];
    const seen = new Set();
    for (const s of symbols) {
      const sym = String(s).trim().toUpperCase();
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      cleaned.push(sym);
    }
    return cleaned.slice(0, 50);
  },

  async fetchQuotes(symbols, timeoutMs) {
    // Cache key based on symbols list
    const key = symbols.join(",");
    const age = nowMs() - this.quotesCache.at;
    if (this.quotesCache.key === key && age < 5_000) {
      return this.quotesCache.rows;
    }

    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(key);

    const json = await this.fetchJson(url, timeoutMs);
    const results = json?.quoteResponse?.result || [];

    const rows = results.map((q) => {
      const preActive = q.preMarketPrice != null && q.preMarketChangePercent != null;
      const postActive = q.postMarketPrice != null && q.postMarketChangePercent != null;

      return {
        symbol: q.symbol,
        name: q.shortName || q.longName || q.displayName || "",
        price: q.regularMarketPrice,
        change: q.regularMarketChange,
        changePercent: q.regularMarketChangePercent,

        preMarketActive: preActive,
        prePrice: q.preMarketPrice,
        preChgPct: q.preMarketChangePercent,

        postMarketActive: postActive,
        postPrice: q.postMarketPrice,
        postChgPct: q.postMarketChangePercent
      };
    });

    this.quotesCache = { at: nowMs(), key, rows };
    return rows;
  },

  async fetchSparklines(symbols, sparkCfg, timeoutMs) {
    const map = new Map();
    const range = sparkCfg.range || "1d";
    const interval = sparkCfg.interval || "5m";
    const cacheMs = sparkCfg.cacheMs ?? 10 * 60_000;
    const pointsMax = clamp(Number(sparkCfg.pointsMax ?? 48), 12, 240);

    // Fetch sequentially to avoid hammering Yahoo
    for (const sym of symbols) {
      const cached = this.sparkCache.get(sym);
      if (cached && (nowMs() - cached.at) < cacheMs) {
        map.set(sym, cached.data);
        continue;
      }

      const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
        `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;

      try {
        const json = await this.fetchJson(url, timeoutMs);

        const result = json?.chart?.result?.[0];
        const closes = result?.indicators?.quote?.[0]?.close || [];
        const cleaned = closes.filter(v => Number.isFinite(Number(v)));

        const down = this.downsample(cleaned, pointsMax);
        this.sparkCache.set(sym, { at: nowMs(), data: down });
        map.set(sym, down);
      } catch (e) {
        // Don’t fail the whole module if one sparkline fails
        map.set(sym, []);
      }
    }

    return map;
  },

  downsample(arr, maxPts) {
    if (!Array.isArray(arr) || arr.length <= maxPts) return arr || [];
    const step = (arr.length - 1) / (maxPts - 1);
    const out = [];
    for (let i = 0; i < maxPts; i++) {
      out.push(arr[Math.round(i * step)]);
    }
    return out;
  },

  async fetchJson(url, timeoutMs) {
    const text = await this.fetchText(url, timeoutMs);
    return JSON.parse(text);
  },

  async fetchText(url, timeoutMs) {
    const fetch = await ensureFetch();
    const res = await fetch(url, { /* ... */ });

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "MagicMirror MMM-Watchlist",
          "Accept": "application/json,text/plain,*/*"
        },
        signal: controller.signal
      });

      if (!res.ok) {
        const hint = res.status === 429 ? " (rate limited; backoff will increase automatically)" : "";
        throw new Error(`HTTP ${res.status} fetching ${url}${hint}`);
      }

      return await res.text();
    } finally {
      clearTimeout(id);
    }
  }

});
