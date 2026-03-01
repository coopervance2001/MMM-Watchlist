/* global Module */

Module.register("MMM-Watchlist", {
  defaults: {
    symbols: ["AAPL", "MSFT", "VOO"],
    symbolsUrl: "",
    refreshInterval: 60 * 1000,
    requestTimeout: 12 * 1000,

    // Your columns (spark last)
    columns: ["symbol", "currentPrice", "previousClose", "change", "changePercent", "spark"],

    decimals: 2,
    showHeader: true,

    sparkline: {
      enabled: true,
      width: 120,
      height: 24,
      limit: 8,
      cacheMs: 10 * 60 * 1000,
      resolution: 5,
      pointsMax: 78
    }
  },

  start: function () {
    this.loaded = false;
    this.dataRows = [];
    this.error = null;

    this.sendSocketNotification("MMM_WL_CONFIG", {
      symbols: this.config.symbols,
      symbolsUrl: this.config.symbolsUrl,
      refreshInterval: this.config.refreshInterval,
      requestTimeout: this.config.requestTimeout,
      provider: this.config.provider,
      apiKey: this.config.apiKey,
      sparkline: this.config.sparkline
    });

    this.updateDom(0);
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "MMM_WL_DATA") {
      this.loaded = true;
      this.error = null;
      this.dataRows = (payload && payload.rows) ? payload.rows : [];
      this.updateDom(150);
      return;
    }

    if (notification === "MMM_WL_ERROR") {
      this.loaded = true;
      this.error = (payload && payload.message) ? payload.message : "Unknown error";
      this.updateDom(150);
    }
  },

  getStyles: function () {
    return ["MMM-Watchlist.css"];
  },

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "mmm-wl";

    if (!this.loaded) {
      wrapper.classList.add("dimmed", "small");
      wrapper.innerText = "Loading watchlist...";
      return wrapper;
    }

    if (this.error) {
      wrapper.classList.add("small");
      wrapper.innerText = "Watchlist error: " + this.error;
      return wrapper;
    }

    if (!this.dataRows || !this.dataRows.length) {
      wrapper.classList.add("dimmed", "small");
      wrapper.innerText = "No symbols to display.";
      return wrapper;
    }

    var table = document.createElement("table");
    table.className = "mmm-wl-table small";

    if (this.config.showHeader) {
      var thead = document.createElement("thead");
      var trh = document.createElement("tr");

      for (var i = 0; i < this.config.columns.length; i++) {
        var col = this.config.columns[i];
        var th = document.createElement("th");
        th.textContent = this.prettyCol(col);
        trh.appendChild(th);
      }

      thead.appendChild(trh);
      table.appendChild(thead);
    }

    var tbody = document.createElement("tbody");

    for (var r = 0; r < this.dataRows.length; r++) {
      var row = this.dataRows[r];
      var tr = document.createElement("tr");

      var chg = Number(row && row.change ? row.change : 0);
      if (chg > 0) tr.classList.add("pos");
      if (chg < 0) tr.classList.add("neg");

      for (var c = 0; c < this.config.columns.length; c++) {
        var colName = this.config.columns[c];
        var td = document.createElement("td");
        td.className = "col-" + colName;

        if (colName === "spark") {
          td.appendChild(this.renderSpark(row));
        } else {
          td.textContent = this.formatCell(colName, row);
        }

        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  },

  prettyCol: function (col) {
    var map = {
      symbol: "Symbols",
      currentPrice: "Cur.Price",
      previousClose: "Prev.Close",
      change: "CHG",
      changePercent: "CHG%",
      spark: ""
    };
    return map[col] || col;
  },

  formatCell: function (col, row) {
    var d = this.config.decimals;

    if (col === "symbol") return (row && row.symbol) ? row.symbol : "";
    if (col === "currentPrice") return this.fmtNum(row ? row.currentPrice : null, d);
    if (col === "previousClose") return this.fmtNum(row ? row.previousClose : null, d);
    if (col === "change") return this.fmtSigned(row ? row.change : null, d);
    if (col === "changePercent") return this.fmtSigned(row ? row.changePercent : null, d) + "%";
    if (col === "spark") return "";

    return (row && row[col] != null) ? String(row[col]) : "";
  },

  renderSpark: function (row) {
    var container = document.createElement("div");
    container.className = "spark";

    var pts = (row && Array.isArray(row.spark)) ? row.spark : [];
    if (!pts || pts.length < 2) return container;

    var w = (this.config.sparkline && this.config.sparkline.width) ? this.config.sparkline.width : 120;
    var h = (this.config.sparkline && this.config.sparkline.height) ? this.config.sparkline.height : 24;

    var min = Infinity, max = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var v = Number(pts[i]);
      if (!isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max) || min === max) return container;

    var svgNS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    var pad = 1;
    var innerW = w - pad * 2;
    var innerH = h - pad * 2;

    function toY(val) {
      var t = (Number(val) - min) / (max - min);
      return (pad + innerH) - t * innerH;
    }

    // dotted baseline at previousClose if within range
    var prevClose = (row && typeof row.previousClose === "number") ? row.previousClose : null;
    if (prevClose != null && isFinite(prevClose) && prevClose >= min && prevClose <= max) {
      var base = document.createElementNS(svgNS, "line");
      base.setAttribute("x1", String(pad));
      base.setAttribute("x2", String(pad + innerW));
      base.setAttribute("y1", String(toY(prevClose)));
      base.setAttribute("y2", String(toY(prevClose)));
      base.setAttribute("class", "spark-baseline");
      svg.appendChild(base);
    }

    var poly = document.createElementNS(svgNS, "polyline");
    var step = innerW / (pts.length - 1);
    var coords = [];
    for (var j = 0; j < pts.length; j++) {
      coords.push((pad + j * step) + "," + toY(pts[j]));
    }
    poly.setAttribute("points", coords.join(" "));
    poly.setAttribute("class", "spark-line");
    svg.appendChild(poly);

    container.appendChild(svg);
    return container;
  },

  fmtNum: function (n, decimals) {
    var num = Number(n);
    if (!isFinite(num)) return "—";
    return num.toFixed(decimals);
  },

  fmtSigned: function (n, decimals) {
    var num = Number(n);
    if (!isFinite(num)) return "—";
    var sign = num > 0 ? "+" : "";
    return sign + num.toFixed(decimals);
  }
});
