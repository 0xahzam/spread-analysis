import json
from pathlib import Path
from typing import Tuple, List

import numpy as np
import pandas as pd

from plotly.subplots import make_subplots
import plotly.graph_objects as go


# read JSON file of OHLCV ‘candles’, parse timestamps and remove duplicates
def load_candles(path: str | Path) -> pd.Series:
    with open(path) as f:
        d = json.load(f)
    df = pd.DataFrame(d["candles"])
    df["start"] = pd.to_datetime(df["start"].astype(int), unit="ms")
    return df.drop_duplicates("start").set_index("start")["oracleClose"].astype(float)


# Return cumulative funding index as float (quote-per-contract)
def load_funding(path: str | Path) -> pd.Series:
    # https://github.com/drift-labs/protocol-v2/blob/9aecb14bebc32fe448b614dc048e7b909708bee4/programs/drift/src/math/constants.rs#L99
    FUND_PREC = 1_000_000_000

    with open(path) as f:
        d = json.load(f)
    df = pd.DataFrame(d["fundingRates"])
    df["ts"] = pd.to_datetime(df["ts"].astype(int), unit="s")
    df = df.sort_values("ts").set_index("ts")
    df["long"] = df["cumulativeFundingRateLong"].astype(float) / FUND_PREC
    df["short"] = df["cumulativeFundingRateShort"].astype(float) / FUND_PREC
    return df[["long", "short"]]


def attach_funding(
    px: pd.DataFrame, drift_f: pd.DataFrame, kmno_f: pd.DataFrame
) -> pd.DataFrame:
    out = px.copy()
    out["fidx_drift_long"] = drift_f["long"].reindex(out.index, method="ffill")
    out["fidx_drift_short"] = drift_f["short"].reindex(out.index, method="ffill")
    out["fidx_kmno_long"] = kmno_f["long"].reindex(out.index, method="ffill")
    out["fidx_kmno_short"] = kmno_f["short"].reindex(out.index, method="ffill")
    return out.fillna(
        {
            "fidx_drift_long": 0.0,
            "fidx_drift_short": 0.0,
            "fidx_kmno_long": 0.0,
            "fidx_kmno_short": 0.0,
        }
    )


# load DRIFT and KMNO oracle‐price series, compute spread, signal, and shift to avoid lookahead
# spread = drift_price − ratio*kmno_price; positive → DRIFT rich, negative → DRIFT cheap
# signal = +1 to long DRIFT / short KMNO when spread < 0
# signal = −1 to short DRIFT / long KMNO when spread > 0
# use yesterday’s signal for trading (last tick/bar)
def prepare_df(
    drift_path: str | Path, kmno_path: str | Path, ratio: float
) -> pd.DataFrame:
    drift = load_candles(drift_path)
    kmno = load_candles(kmno_path)

    price_df = pd.concat([drift, kmno], axis=1, keys=["drift", "kmno"]).dropna()
    price_df["spread"] = price_df["drift"] - ratio * price_df["kmno"]
    price_df["signal"] = -np.sign(price_df["spread"])
    price_df["signal_yest"] = price_df["signal"].shift(1)

    drift_f = load_funding("../data/funding/drift-perp.json")
    kmno_f = load_funding("../data/funding/kmno-perp.json")
    price_df = attach_funding(price_df, drift_f, kmno_f)

    return price_df.dropna(subset=["signal_yest"])


# USD fee for one fill on one leg
def fee(qty: float, price: float, rate: float = 0.001) -> float:
    FEE_RATE = 0.001  # 10 bps taker fee
    return abs(qty) * price * FEE_RATE


def _open_position(
    ts: pd.Timestamp,
    signal: int,
    row: pd.Series,
    qty_drift: float,
    qty_kmno: float,
) -> Tuple:
    capital = qty_drift * row.drift + qty_kmno * row.kmno
    open_fee = fee(qty_drift, row.drift) + fee(qty_kmno, row.kmno)

    fidx_d = row["fidx_drift_long"] if signal > 0 else row["fidx_drift_short"]
    fidx_k = row["fidx_kmno_short"] if signal > 0 else row["fidx_kmno_long"]

    return (
        ts,
        signal,
        row.drift,
        row.kmno,
        qty_drift,
        qty_kmno,
        capital - open_fee,
        open_fee,
        fidx_d,
        fidx_k,
    )


# backtest loop using tuple state and clear prints
# skip flat signal, open initial position, flip on signal change, compute PnL, and final close
def backtest(
    price_df: pd.DataFrame,
    ratio: float,
    init_drift_amt: float,
    rebalance_freq: int,
    VERBOSE: bool = True,
) -> Tuple[pd.DataFrame, float]:
    position = None
    starting_capital = 0
    trades: List[Tuple] = []

    for i in range(0, len(price_df), rebalance_freq):
        row = price_df.iloc[i]

        # timestamp, signal
        timestamp, signal = row.name, int(row.signal_yest)

        if signal == 0:  # skip flat signal (no position)
            continue

        if position is None:  # open first position: 1:10::DRIFT:KMNO
            qty_drift = init_drift_amt
            qty_kmno = ratio * qty_drift
            position = _open_position(timestamp, signal, row, qty_drift, qty_kmno)
            starting_capital = position[6]
            if VERBOSE:
                print(f"{timestamp}\tOPEN\ts={signal}\t\t\tcapital=${position[6]:.2f}")
            continue

        (
            entry_time,
            entry_signal,
            entry_drift,
            entry_kmno,
            qty_drift,
            qty_kmno,
            capital_at_entry,
            entry_fee,
            fidx_d_entry,
            fidx_k_entry,
        ) = position

        if signal == entry_signal:  # if signal unchanged, hold current position
            continue

        # on signal flip: close existing position and compute PnL
        # signal * quantity * (current price - open price)
        drift_pnl = entry_signal * qty_drift * (row.drift - entry_drift)
        kmno_pnl = -entry_signal * qty_kmno * (row.kmno - entry_kmno)
        close_fee = fee(qty_drift, row.drift) + fee(qty_kmno, row.kmno)

        fidx_d_exit = (
            row["fidx_drift_long"] if entry_signal > 0 else row["fidx_drift_short"]
        )
        fidx_k_exit = (
            row["fidx_kmno_short"] if entry_signal > 0 else row["fidx_kmno_long"]
        )

        funding_d = -entry_signal * qty_drift * (fidx_d_exit - fidx_d_entry)
        funding_k = entry_signal * qty_kmno * (fidx_k_exit - fidx_k_entry)

        total_pnl = drift_pnl + kmno_pnl + funding_d + funding_k - entry_fee - close_fee
        capital = capital_at_entry + total_pnl

        trades.append(
            (
                entry_time,
                timestamp,
                entry_signal,
                drift_pnl,
                kmno_pnl,
                total_pnl,
                total_pnl / capital_at_entry,
            )
        )

        if VERBOSE:
            print(
                f"{timestamp}\tCLOSE\ts={entry_signal}\tpnl=${total_pnl:.2f}\tcapital=${capital:.2f}"
            )

        # open new position mantaining 1:10 ratio
        qty_drift = capital / (row.drift + ratio * row.kmno)
        qty_kmno = ratio * qty_drift
        position = _open_position(timestamp, signal, row, qty_drift, qty_kmno)
        if VERBOSE:
            print(f"{timestamp}\tOPEN\ts={signal}\t\t\tcapital=${position[6]:.2f}")

    if position:  # force final close at end of data if still in position
        (
            entry_time,
            entry_signal,
            entry_drift,
            entry_kmno,
            qty_drift,
            qty_kmno,
            capital_at_entry,
            entry_fee,
            fidx_d_entry,
            fidx_k_entry,
        ) = position
        row = price_df.iloc[-1]
        timestamp = row.name

        drift_pnl = entry_signal * qty_drift * (row.drift - entry_drift)
        kmno_pnl = -entry_signal * qty_kmno * (row.kmno - entry_kmno)

        close_fee = fee(qty_drift, row.drift) + fee(qty_kmno, row.kmno)

        fidx_d_exit = (
            row["fidx_drift_long"] if entry_signal > 0 else row["fidx_drift_short"]
        )
        fidx_k_exit = (
            row["fidx_kmno_short"] if entry_signal > 0 else row["fidx_kmno_long"]
        )

        funding_d = -entry_signal * qty_drift * (fidx_d_exit - fidx_d_entry)
        funding_k = entry_signal * qty_kmno * (fidx_k_exit - fidx_k_entry)

        total_pnl = drift_pnl + kmno_pnl + funding_d + funding_k - entry_fee - close_fee
        capital = capital_at_entry + total_pnl

        trades.append(
            (
                entry_time,
                timestamp,
                entry_signal,
                drift_pnl,
                kmno_pnl,
                total_pnl,
                total_pnl / capital_at_entry,
            )
        )

        if VERBOSE:
            print(
                f"{timestamp}\tCLOSE\ts={entry_signal}\tpnl=${total_pnl:.2f}\tcapital=${capital:.2f}\n"
            )

    trades_df = pd.DataFrame(
        trades,
        columns=[
            "entry_time",
            "exit_time",
            "signal",
            "drift_pnl_usd",
            "kmno_pnl_usd",
            "total_pnl_usd",
            "pnl_pct",
        ],
    )

    return trades_df, starting_capital


def compute_stats(trades_df: pd.DataFrame, initial_capital: float) -> dict:
    if trades_df.empty or initial_capital == 0:
        return {
            "net_usd": 0,
            "final_pct": 0,
            "sharpe": 0,
            "min_drawdown": 0,
            "win_rate": 0,
            "trades_per_year": 0,
            "avg_hold_hrs": 0,
        }

    # stats
    net_usd = trades_df["total_pnl_usd"].sum()
    final_pct = net_usd / initial_capital * 100

    total_days = (
        trades_df["exit_time"].max() - trades_df["entry_time"].min()
    ).total_seconds() / 86400
    trades_per_year = len(trades_df) / total_days * 365
    returns = trades_df["pnl_pct"]

    avg_hours = (
        trades_df["exit_time"] - trades_df["entry_time"]
    ).dt.total_seconds().mean() / 3600

    # sharpe
    rf_annual = 0.0406
    rf_per_trade = rf_annual * (avg_hours / 8760)
    excess_ret = returns - rf_per_trade
    std = excess_ret.std()
    sharpe = (excess_ret.mean() / std * np.sqrt(8760 / avg_hours)) if std > 1e-8 else 0

    # equity curve and drawdown
    equity = trades_df["total_pnl_usd"].cumsum() + initial_capital
    drawdown = equity / equity.cummax() - 1
    min_dd = drawdown.min() * 100

    # win rate
    win_rate = (returns > 0).mean() * 100

    return {
        "net_usd": net_usd,
        "final_pct": final_pct,
        "sharpe": sharpe,
        "min_drawdown": min_dd,
        "win_rate": win_rate,
        "trades_per_year": trades_per_year,
        "avg_hold_hrs": avg_hours,
    }


# run backtest for all update frequencies for eg. between 15m and 24h
def run_sweep(
    price_df: pd.DataFrame,
    ratio: float,
    init_drift_amt: float,
    max_freq: int = 96,
) -> pd.DataFrame:
    results = []
    for freq in range(1, max_freq + 1):
        trades_df, capital_0 = backtest(
            price_df, ratio, init_drift_amt, freq, VERBOSE=False
        )
        stats = compute_stats(trades_df, capital_0)
        results.append(
            (
                freq,
                stats["net_usd"],
                stats["final_pct"],
                stats["sharpe"],
                stats["min_drawdown"],
                stats["win_rate"],
                stats["trades_per_year"],
                stats["avg_hold_hrs"],
            )
        )
    return pd.DataFrame(
        results,
        columns=[
            "update_freq",
            "net_usd",
            "final_pct",
            "sharpe",
            "min_drawdown",
            "win_rate",
            "trades_per_year",
            "avg_hold_hrs",
        ],
    )


if __name__ == "__main__":
    ratio = 10  # target 1 DRIFT vs 10 KMNO in synthetic basket
    init_drift_amt = 1

    price_df = prepare_df(
        "../data/price/drift_15m_90days.json",
        "../data/price/kmno_15m_90days.json",
        ratio,
    )

    # df_results = run_sweep(price_df, ratio, init_drift_amt)
    # df_results.to_csv("backtest_results.csv", index=False)

    # fig = make_subplots(
    #     rows=3,
    #     cols=1,
    #     shared_xaxes=True,
    #     vertical_spacing=0.05,
    #     subplot_titles=["PnL (%)", "Sharpe Ratio", "Min Drawdown (%)"],
    # )

    # fig.add_trace(
    #     go.Scatter(
    #         x=df_results["update_freq"],
    #         y=df_results["final_pct"],
    #         mode="lines+markers",
    #         name="PnL %",
    #     ),
    #     row=1,
    #     col=1,
    # )

    # fig.add_trace(
    #     go.Scatter(
    #         x=df_results["update_freq"],
    #         y=df_results["sharpe"],
    #         mode="lines+markers",
    #         name="Sharpe Ratio",
    #     ),
    #     row=2,
    #     col=1,
    # )

    # fig.add_trace(
    #     go.Scatter(
    #         x=df_results["update_freq"],
    #         y=df_results["min_drawdown"],
    #         mode="lines+markers",
    #         name="Min Drawdown",
    #     ),
    #     row=3,
    #     col=1,
    # )

    # fig.update_layout(
    #     height=1200,
    #     title_text="Strategy Metrics by Update Frequency",
    #     template="plotly_white",
    #     showlegend=False,
    #     xaxis3=dict(title="Update Frequency (bars)"),
    # )

    # fig.show()
    # fig.write_image("../plots/backtest.png", width=1920, height=1080, scale=2)
