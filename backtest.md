# DRIFT–KMNO Convergence Arbitrage Backtest

### Overview

This backtest evaluates a simple **taker arbitrage** strategy between `DRIFT/USD` and `KMNO/USD` perpetual markets on the Drift protocol. It assumes a fixed basket ratio and acts on **mean-reverting spread signals**.

The system executes **taker trades** based on the sign of a normalized spread:

> Long DRIFT / Short KMNO when DRIFT is cheap relative to KMNO (negative spread)
> Short DRIFT / Long KMNO when DRIFT is rich (positive spread)

Positions are rebalanced at fixed time intervals, and trades are triggered only on **signal flips**.

---

### Dataset

- Source: Oracle prices from Drift protocol
- Assets: `DRIFT/USD`, `KMNO/USD`
- Frequency: 15-minute candles
- Duration: 90 days

---

### Spread and Signal Construction

We define a **linear spread** as:

```
spread = drift_price − ratio × kmno_price
```

- `ratio`: target hedge ratio between DRIFT and KMNO (e.g., 10)
- `signal`: `+1` to long DRIFT / short KMNO when spread < 0
  `-1` to short DRIFT / long KMNO when spread > 0
  `0` if spread is exactly zero

The backtest uses the **previous bar's signal** to avoid lookahead.

---

### Backtest Logic

- Capital is allocated into a synthetic **DRIFT + ratio × KMNO** basket
- Entry: on first valid signal
- Rebalance: on **signal flip** at fixed frequency
- Position size is recalculated at each trade based on current capital
- P\&L is computed in USD and includes both legs
- Strategy always holds a position unless the signal is flat

Final position is force-closed at the end of the series.

---

### Key Parameters

| Parameter       | Value                 |
| --------------- | --------------------- |
| Hedge Ratio     | `10`                  |
| Initial Capital | `$11` (1 + 10 units)  |
| Rebalance Freq  | `4 × 6` bars (1 hour) |
| Risk-Free Rate  | `4.06%` annualized    |

---

### Statistics

The backtest logs the following performance metrics:

- **Net P\&L** in USD and %
- **Annualized Sharpe Ratio** (per-trade returns)
- **Trades per Year**
- **Minimum Drawdown** (% from equity peak)
- **Win Rate** (% of profitable trades)
- **Average Hold Time** per trade (in hours)

---

### Example Output (Rebalance = 24h)

```
2025-02-16 21:30:00     OPEN    s=1                     capital=$11.00
2025-03-03 21:30:00     CLOSE   s=1     pnl=$2.13       capital=$13.13
2025-03-03 21:30:00     OPEN    s=-1                    capital=$13.13
2025-03-13 21:30:00     CLOSE   s=-1    pnl=$0.18       capital=$13.31
2025-03-13 21:30:00     OPEN    s=1                     capital=$13.31
2025-03-15 21:30:00     CLOSE   s=1     pnl=$0.89       capital=$14.20
2025-03-15 21:30:00     OPEN    s=-1                    capital=$14.20
2025-04-13 21:30:00     CLOSE   s=-1    pnl=$0.87       capital=$15.07
2025-04-13 21:30:00     OPEN    s=1                     capital=$15.07
2025-04-30 21:30:00     CLOSE   s=1     pnl=$2.12       capital=$17.19
2025-04-30 21:30:00     OPEN    s=-1                    capital=$17.19
2025-05-01 21:30:00     CLOSE   s=-1    pnl=$2.43       capital=$19.62
2025-05-01 21:30:00     OPEN    s=1                     capital=$19.62
2025-05-17 10:15:00     CLOSE   s=1     pnl=$0.90       capital=$20.52

Net P&L: $9.52 (86.50%)
Trades/year: 28.5
Sharpe (annualized): 7.73
Min drawdown: 0.00%
Win rate: 100.00% over 7 trades
Avg hold time per trade: 306.96h
```

---

### Notes

- All trades are **executed at oracle prices**, assuming no slippage or fees
- Position sizing is dynamically adjusted to **current capital and basket value**
