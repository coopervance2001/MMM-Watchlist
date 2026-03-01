/* global Module, Log */

Module.register("MMM-Watchlist", {
    defaults: {
      symbols: ["AAPL", "MSFT", "VOO"],
      symbolsUrl: "",
      refreshInterval: 60 * 1000,
      requestTimeout: 12 * 1000,
      columns: ["symbol", "currentPrice", "previousOpen", "change", "changePercent"],
      maxNameLength: 24,
      decimals: 2,
      showHeader: true,
      sort: "none",
      sparkline: { enabled: true, width: 120, height: 24 }
    },
  
    start: function () {
      this.loaded = false;
      this.dataRows = [];
      this.error = null;
      Log.log("[MMM-Watchlist] front-end start() ran");
  
      this.sendSocketNotification("MMM_WL_CONFIG", {
        symbols: this.config.symbols,
        symbolsUrl: this.config.symbolsUrl,
        refreshInterval: this.config.refreshInterval,
        requestTimeout: this.config.requestTimeout,
        provider: this.config.provider,
        apiKey: this.config.apiKey
      });
  
      this.updateDom(0);
    },
  
    socketNotificationReceived: function (notification, payload) {
      if (notification === "MMM_WL_DATA") {
        this.loaded = true;
        this.error = null;
        this.dataRows = (payload && payload.rows) ? payload.rows : [];
        this.updateDom(150);
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
  
      if (col === "spark") return "";
      if (col === "symbol") return (row && row.symbol) ? row.symbol : "";

      if (col === "currentPrice") return this.fmtNum(row ? row.currentPrice : null, d);
      if (col === "previousClose") return this.fmtNum(row ? row.previousClose : null, d);
      if (col === "change") return this.fmtSigned(row ? row.change : null, d);
      if (col === "changePercent") return this.fmtSigned(row ? row.changePercent : null, d) + "%";
  
      return (row && row[col] != null) ? String(row[col]) : "";
    },
  
    renderSpark: function (row) {
      var container = document.createElement("div");
      container.className = "spark";
      // keep it blank if no spark data
      return container;
    },
  
    fmtNum: function (n, decimals) {
      var num = Number(n);
      if (!isFinite(num)) return "â€”";
      return num.toFixed(decimals);
    },
  
    fmtSigned: function (n, decimals) {
      var num = Number(n);
      if (!isFinite(num)) return "â€”";
      var sign = num > 0 ? "+" : "";
      return sign + num.toFixed(decimals);
    }
  });
  


