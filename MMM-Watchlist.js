/* global Module */

Module.register("MMM-Watchlist", {
    defaults: {
      symbols: ["AAPL", "MSFT", "VOO"],
      symbolsUrl: "",
  
      refreshInterval: 60 * 1000,   // base refresh
      requestTimeout: 12 * 1000,
  
      // Backoff when rate-limited / transient failures
      backoff: {
        enabled: true,
        initialMs: 60 * 1000,       // start backoff at 60s
        maxMs: 15 * 60 * 1000,      // cap at 15m
        multiplier: 2,
        jitterRatio: 0.15
      },
  
      // Sparklines
      sparkline: {
        enabled: true,
        range: "1d",          // "1d" is nice for mirrors
        interval: "5m",       // 5-minute candles
        pointsMax: 48,        // downsample to keep it light
        width: 120,
        height: 24,
        limit: 12,            // only fetch/render for first N symbols
        cacheMs: 10 * 60 * 1000
      },
  
      // Columns to show (order matters)
      // Added: "spark", "prePrice", "preChgPct", "postPrice", "postChgPct"
      columns: ["symbol", "name", "price", "change", "changePercent", "prePrice", "preChgPct", "postPrice", "postChgPct", "spark"],
  
      maxNameLength: 24,
      decimals: 2,
      showHeader: true,
  
      // Sorting (NOT by %). Default: keep your list order.
      sort: "none" // "none" | "symbol"
    },
  
    start() {
      this.loaded = false;
      this.dataRows = [];
      this.error = null;
  
      this.sendSocketNotification("MMM_WL_CONFIG", {
        symbols: this.config.symbols,
        symbolsUrl: this.config.symbolsUrl,
        refreshInterval: this.config.refreshInterval,
        requestTimeout: this.config.requestTimeout,
        backoff: this.config.backoff,
        sparkline: this.config.sparkline,
        sort: this.config.sort
      });
  
      this.updateDom(0);
    },
  
    socketNotificationReceived(notification, payload) {
      if (notification === "MMM_WL_DATA") {
        this.loaded = true;
        this.error = null;
        this.dataRows = payload.rows || [];
        this.updateDom(150);
      }
  
      if (notification === "MMM_WL_ERROR") {
        this.loaded = true;
        this.error = payload?.message || "Unknown error";
        this.updateDom(150);
      }
    },
  
    getStyles() {
      return ["MMM-Watchlist.css"];
    },
  
    getDom() {
      const wrapper = document.createElement("div");
      wrapper.className = "mmm-wl";
  
      if (!this.loaded) {
        wrapper.classList.add("dimmed", "small");
        wrapper.innerText = "Loading watchlist…";
        return wrapper;
      }
  
      if (this.error) {
        wrapper.classList.add("small");
        wrapper.innerText = `Watchlist error: ${this.error}`;
        return wrapper;
      }
  
      if (!this.dataRows.length) {
        wrapper.classList.add("dimmed", "small");
        wrapper.innerText = "No symbols to display.";
        return wrapper;
      }
  
      const table = document.createElement("table");
      table.className = "mmm-wl-table small";
  
      if (this.config.showHeader) {
        const thead = document.createElement("thead");
        const tr = document.createElement("tr");
        for (const col of this.config.columns) {
          const th = document.createElement("th");
          th.textContent = this.prettyCol(col);
          tr.appendChild(th);
        }
        thead.appendChild(tr);
        table.appendChild(thead);
      }
  
      const tbody = document.createElement("tbody");
  
      for (const row of this.dataRows) {
        const tr = document.createElement("tr");
  
        const chg = Number(row.change ?? 0);
        if (chg > 0) tr.classList.add("pos");
        if (chg < 0) tr.classList.add("neg");
  
        for (const col of this.config.columns) {
          const td = document.createElement("td");
          td.className = `col-${col}`;
  
          if (col === "spark") {
            td.appendChild(this.renderSpark(row));
          } else {
            td.textContent = this.formatCell(col, row);
          }
  
          tr.appendChild(td);
        }
  
        tbody.appendChild(tr);
      }
  
      table.appendChild(tbody);
      wrapper.appendChild(table);
      return wrapper;
    },
  
    prettyCol(col) {
      const map = {
        symbol: "Symbol",
        name: "Name",
        price: "Last",
        change: "Chg",
        changePercent: "Chg%",
        prePrice: "Pre",
        preChgPct: "Pre%",
        postPrice: "After",
        postChgPct: "After%",
        spark: ""
      };
      return map[col] ?? col;
    },
  
    formatCell(col, row) {
      const d = this.config.decimals;
  
      switch (col) {
        case "symbol":
          return row.symbol || "";
  
        case "name": {
          const name = row.name || "";
          return name.length > this.config.maxNameLength
            ? name.slice(0, this.config.maxNameLength - 1) + "…"
            : name;
        }
  
        case "price":
          return this.fmtNum(row.price, d);
  
        case "change":
          return this.fmtSigned(row.change, d);
  
        case "changePercent":
          return this.fmtSigned(row.changePercent, d) + "%";
  
        case "prePrice":
          return row.preMarketActive ? this.fmtNum(row.prePrice, d) : "—";
  
        case "preChgPct":
          return row.preMarketActive ? (this.fmtSigned(row.preChgPct, d) + "%") : "—";
  
        case "postPrice":
          return row.postMarketActive ? this.fmtNum(row.postPrice, d) : "—";
  
        case "postChgPct":
          return row.postMarketActive ? (this.fmtSigned(row.postChgPct, d) + "%") : "—";
  
        default:
          return row[col] != null ? String(row[col]) : "";
      }
    },
  
    renderSpark(row) {
      const w = this.config.sparkline.width;
      const h = this.config.sparkline.height;
  
      const container = document.createElement("div");
      container.className = "spark";
  
      const pts = Array.isArray(row.spark) ? row.spark : [];
      if (!this.config.sparkline.enabled || pts.length < 2) {
        container.textContent = "";
        return container;
      }
  
      // Normalize points into SVG space
      let min = Infinity, max = -Infinity;
      for (const v of pts) {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        if (n < min) min = n;
        if (n > max) max = n;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
        return container;
      }
  
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("width", String(w));
      svg.setAttribute("height", String(h));
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  
      const poly = document.createElementNS(svgNS, "polyline");
  
      const toY = (v) => {
        const t = (Number(v) - min) / (max - min);
        return (h - 1) - t * (h - 2);
      };
  
      const step = (w - 2) / (pts.length - 1);
      const coords = pts.map((v, i) => `${1 + i * step},${toY(v)}`).join(" ");
      poly.setAttribute("points", coords);
  
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke-width", "1.5");
      // Stroke color is handled in CSS via currentColor
  
      svg.appendChild(poly);
      container.appendChild(svg);
      return container;
    },
  
    fmtNum(n, decimals) {
      const num = Number(n);
      if (!Number.isFinite(num)) return "—";
      return num.toFixed(decimals);
    },
  
    fmtSigned(n, decimals) {
      const num = Number(n);
      if (!Number.isFinite(num)) return "—";
      const sign = num > 0 ? "+" : "";
      return sign + num.toFixed(decimals);
    }
  }
});
