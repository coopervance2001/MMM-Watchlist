{
    module: "MMM-Watchlist",
    position: "top_right",
    config: {
      symbols: ["AAPL", "MSFT", "RKLB", "VOO", "TSLA"],
  
      refreshInterval: 60 * 1000,
  
      columns: [
        "symbol", "price", "changePercent",
        "prePrice", "preChgPct",
        "postPrice", "postChgPct",
        "spark"
      ],
  
      sparkline: {
        enabled: true,
        range: "1d",
        interval: "5m",
        pointsMax: 48,
        width: 110,
        height: 22,
        limit: 10,
        cacheMs: 10 * 60 * 1000
      },
  
      sort: "none"
    }
  },