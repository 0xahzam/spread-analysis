Here’s your updated **README**, corrected to reflect the **unit-based model** (not basket-based), along with tightened phrasing and aligned terminology:

---

# DRIFT–KMNO Convergence Arbitrage Backtest

### Overview

This backtest evaluates a simple **taker arbitrage** strategy between `DRIFT/USD` and `KMNO/USD` perpetual markets on the Drift protocol. It operates on **mean-reverting spread signals** and maintains a fixed exposure ratio of **1 DRIFT : 10 KMNO**.

Trades are executed on **signal flips** based on the sign of the linear spread:

> Long DRIFT / Short KMNO when DRIFT is cheap relative to KMNO (`spread < 0`)
> Short DRIFT / Long KMNO when DRIFT is rich (`spread > 0`)

---

### Dataset

- Source: Drift protocol oracle prices
- Assets: `DRIFT/USD`, `KMNO/USD`
- Frequency: 15-minute candles
- Duration: 90 days

---

### Spread and Signal Construction

```
spread = drift_price − ratio × kmno_price
```

- `ratio`: fixed exposure ratio (e.g., 10)
- `signal`:

  - `+1` → long DRIFT / short KMNO
  - `−1` → short DRIFT / long KMNO
  - `0` → no position (flat spread)

To avoid lookahead bias, the strategy uses the **previous bar's signal** for execution.

---

### Backtest Logic

- Starts with **1 DRIFT and 10 KMNO** exposure (scaled by capital)
- Trades occur **only on signal flips**
- Capital is fully redeployed at each trade based on current market prices
- P\&L is computed in USD from both legs
- Strategy stays in position until a signal reversal

At the end of the series, the final position is **force-closed** at market.

---

### Key Parameters

| Parameter       | Value                    |
| --------------- | ------------------------ |
| Exposure Ratio  | `1 DRIFT : 10 KMNO`      |
| Initial Capital | Based on starting prices |
| Rebalance Freq  | `4 × 6` bars (1 hour)    |
| Risk-Free Rate  | `4.06%` annualized       |

---

### Statistics

The backtest reports:

- **Net P\&L** in USD and %
- **Sharpe Ratio** (annualized, per-trade returns)
- **Trades per Year**
- **Max Drawdown** (from peak equity)
- **Win Rate** (% of profitable trades)
- **Avg Hold Duration** (per trade, in hours)

---

### Notes

- Trades use **oracle-close prices** (no slippage or fees)
- Position sizing is always updated using **live market prices**
- The system does **not predict** direction — it **reacts to mean reversion**
