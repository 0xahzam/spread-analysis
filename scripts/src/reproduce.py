import json
import numpy as np
import pandas as pd
from pathlib import Path
from typing import NamedTuple, Optional, Tuple
import plotly.graph_objects as go
from joblib import Parallel, delayed
from plotly.subplots import make_subplots


class Position(NamedTuple):
    signal: int
    px_drift: float
    px_kmno: float
    qty_drift: float
    qty_kmno: float
    capital_net: float
    fee_open: float
    fidx_drift: float
    fidx_kmno: float


class MTM(NamedTuple):
    pnl_drift: float
    pnl_kmno: float
    funding_drift: float
    funding_kmno: float
    equity: float


FEE_RATE = 0.001  # 10 bps taker


# open/close fees
def fee(qty: float, price: float) -> float:
    return abs(qty) * price * FEE_RATE


# read JSON file of OHLCV ‘candles’, parse timestamps and remove duplicates
def load_candles(path: str | Path) -> pd.Series:
    with open(path) as f:
        d = json.load(f)
    df = pd.DataFrame(d["candles"])
    df["start"] = pd.to_datetime(df["start"].astype(int), unit="ms")
    return df.drop_duplicates("start").set_index("start")["oracleClose"].astype(float)


# load cumulative funding index (float, quote-per-contract)
def load_funding(path: str | Path) -> pd.Series:
    FUND_PREC = 1_000_000_000
    with open(path) as f:
        d = json.load(f)
    df = pd.DataFrame(d["fundingRates"])
    df["ts"] = pd.to_datetime(df["ts"].astype(int), unit="s")
    df = df.sort_values("ts").set_index("ts")
    df["long"] = df["cumulativeFundingRateLong"].astype(float) / FUND_PREC
    df["short"] = df["cumulativeFundingRateShort"].astype(float) / FUND_PREC
    return df[["long", "short"]]


# load DRIFT and KMNO oracle‐price series, compute spread, signal, and shift to avoid lookahead
# spread = drift_price − ratio*kmno_price; positive → DRIFT rich, negative → DRIFT cheap
# signal = +1 to long DRIFT / short KMNO when spread < 0
# signal = −1 to short DRIFT / long KMNO when spread > 0
# use yesterday’s signal for trading (last tick/bar)
def prepare_df(drift_path: str, kmno_path: str, ratio: float) -> pd.DataFrame:
    drift = load_candles(drift_path)
    kmno = load_candles(kmno_path)
    df = pd.concat([drift, kmno], axis=1, keys=["drift", "kmno"]).dropna()
    df["spread"] = df["drift"] - ratio * df["kmno"]
    # df["signal"] = -np.sign(df["spread"])
    # df["signal_yest"] = df["signal"].shift(1)

    # CHANGED: Use two period lag of spread sign
    df["signal_yest"] = -np.sign(df["spread"]).shift(2)

    f_drift = load_funding("../data/funding/drift-perp.json")
    f_kmno = load_funding("../data/funding/kmno-perp.json")

    df["fidx_drift_long"] = f_drift["long"].reindex(df.index, method="ffill").fillna(0)
    df["fidx_drift_short"] = (
        f_drift["short"].reindex(df.index, method="ffill").fillna(0)
    )
    df["fidx_kmno_long"] = f_kmno["long"].reindex(df.index, method="ffill").fillna(0)
    df["fidx_kmno_short"] = f_kmno["short"].reindex(df.index, method="ffill").fillna(0)

    return df.dropna(subset=["signal_yest"])


# mark-to-market PnL, funding, equity
def open_position(sig: int, row: pd.Series, capital: float, ratio: float) -> Position:
    # qd = capital / (row.drift + ratio * row.kmno)
    # qk = ratio * qd

    qd = 1.0  # Fixed 1 DRIFT
    qk = 10.0  # Fixed 10 KMNO

    fee_open = dual_fee(qd, row.drift, qk, row.kmno)
    # f_d = row.fidx_drift_long if sig > 0 else row.fidx_drift_short
    # f_k = row.fidx_kmno_short if sig > 0 else row.fidx_kmno_long

    f_d = 0
    f_k = 0

    return Position(
        sig, row.drift, row.kmno, qd, qk, capital - fee_open, fee_open, f_d, f_k
    )


def mark_to_market(pos: Position, row: pd.Series) -> MTM:
    pnl_d = pos.signal * pos.qty_drift * (row.drift - pos.px_drift)
    pnl_k = -pos.signal * pos.qty_kmno * (row.kmno - pos.px_kmno)
    # fidx_d1 = row.fidx_drift_long if pos.signal > 0 else row.fidx_drift_short
    # fidx_k1 = row.fidx_kmno_short if pos.signal > 0 else row.fidx_kmno_long
    # funding_d = -pos.signal * pos.qty_drift * (fidx_d1 - pos.fidx_drift)
    # funding_k = pos.signal * pos.qty_kmno * (fidx_k1 - pos.fidx_kmno)

    funding_d, funding_k = 0, 0

    equity = pos.capital_net + pnl_d + pnl_k + funding_d + funding_k
    return MTM(pnl_d, pnl_k, funding_d, funding_k, equity)


def dual_fee(qd, pd, qk, pk):
    return (abs(qd) * pd + abs(qk) * pk) * FEE_RATE


def make_snap(ts, signal, drift_px, kmno_px):
    return {
        "ts": ts,
        "drift_px": drift_px,
        "kmno_px": kmno_px,
        "signal": signal,
        "is_entry": False,
        "is_exit": False,
        "qty_drift": 0.0,
        "qty_kmno": 0.0,
        "pnl_drift": 0.0,
        "pnl_kmno": 0.0,
        "funding_drift": 0.0,
        "funding_kmno": 0.0,
        "fee": 0.0,
        "equity": np.nan,
    }


def backtest(
    df: pd.DataFrame, ratio: float, init_qty: float, rebalance_freq: int
) -> Tuple[pd.DataFrame, float]:
    timeline = []
    position: Optional[Position] = None
    capital_0 = 0

    rebalance_mask = pd.Series(False, index=df.index)
    rebalance_mask.iloc[::rebalance_freq] = True

    for i, row in enumerate(df.itertuples(index=True)):
        ts = row.Index
        drift_px = row.drift
        kmno_px = row.kmno
        rebalance_now = rebalance_mask.iloc[i]
        signal = int(row.signal_yest)  # +1, −1, or 0
        snap = make_snap(ts, signal, drift_px, kmno_px)

        # mark existing position
        if position is not None:
            mtm = mark_to_market(position, row)
            equity_now = mtm.equity

            snap["qty_drift"] = position.qty_drift
            snap["qty_kmno"] = position.qty_kmno
            snap["pnl_drift"] = mtm.pnl_drift
            snap["pnl_kmno"] = mtm.pnl_kmno
            snap["funding_drift"] = mtm.funding_drift
            snap["funding_kmno"] = mtm.funding_kmno
            snap["equity"] = equity_now

            if rebalance_now and signal != position.signal:  # close old leg
                fee_close = dual_fee(
                    position.qty_drift, row.drift, position.qty_kmno, row.kmno
                )

                fee_close = 0
                cap_1 = equity_now - fee_close
                snap["is_exit"] = True
                snap["fee"] = fee_close
                snap["equity"] = cap_1

                if signal:  # open new leg immediately
                    position = open_position(signal, row, cap_1, ratio)
                    snap["is_entry"] = True
                    snap["qty_drift"] = position.qty_drift
                    snap["qty_kmno"] = position.qty_kmno
                    snap["fee"] += position.fee_open
                else:
                    position = None

        # no position, maybe open
        elif signal and rebalance_now:
            # capital_0 = init_qty * row.drift + ratio * init_qty * row.kmno
            # CHANGED
            capital_0 = 1.0 * row.drift + 10.0 * row.kmno  # 1 DRIFT + 10 KMNO

            position = open_position(signal, row, capital_0, ratio)
            snap["is_entry"] = True
            snap["qty_drift"] = position.qty_drift
            snap["qty_kmno"] = position.qty_kmno
            snap["fee"] = position.fee_open
            snap["equity"] = position.capital_net

        timeline.append(snap)

    # final close
    if position:
        row = df.iloc[-1]
        ts = row.name
        drift_px = row.drift
        kmno_px = row.kmno
        mtm = mark_to_market(position, row)
        fee_close = dual_fee(position.qty_drift, row.drift, position.qty_kmno, row.kmno)
        cap_1 = mtm.equity - fee_close

        timeline.append(
            {
                "ts": ts,
                "drift_px": drift_px,
                "kmno_px": kmno_px,
                "signal": position.signal,
                "is_entry": False,
                "is_exit": True,
                "qty_drift": position.qty_drift,
                "qty_kmno": position.qty_kmno,
                "pnl_drift": mtm.pnl_drift,
                "pnl_kmno": mtm.pnl_kmno,
                "funding_drift": mtm.funding_drift,
                "funding_kmno": mtm.funding_kmno,
                "fee": fee_close,
                "equity": cap_1,
            }
        )

    return pd.DataFrame(timeline).set_index("ts"), capital_0


def compute_stats(timeline: pd.DataFrame, capital_0: float) -> dict:
    if capital_0 == 0 or timeline.empty:
        return {
            k: 0
            for k in [
                "net_usd",
                "final_pct",
                "sharpe",
                "min_drawdown",
                "win_rate",
                "trades_per_year",
                "avg_hold_hrs",
            ]
        }

    equity = timeline["equity"].ffill().dropna()
    duration = (timeline.index[-1] - timeline.index[0]).total_seconds() / 86400

    trades = timeline[timeline.is_exit]
    trade_returns = trades["equity"].diff().dropna()
    hold_durations = trades.index.to_series().diff().dt.total_seconds().dropna() / 3600

    rf_ann = 0.0406
    avg_hold = hold_durations.mean() if not hold_durations.empty else 1
    rf_trade = rf_ann * (avg_hold / 8760)
    excess = trade_returns / capital_0 - rf_trade
    std = excess.std()

    return {
        "net_usd": equity.iloc[-1] - capital_0,
        "final_pct": (equity.iloc[-1] / capital_0 - 1) * 100,
        "sharpe": (excess.mean() / std * np.sqrt(8760 / avg_hold)) if std > 1e-8 else 0,
        "min_drawdown": 100 * (equity / equity.cummax() - 1).min(),
        "win_rate": 100 * (trade_returns > 0).mean(),
        "trades_per_year": len(trade_returns) / duration * 365,
        "avg_hold_hrs": avg_hold,
    }


def sweep_freq(price_df, ratio, init_drift_amt, max_freq=96, n_jobs=-1):
    def run(freq):
        timeline, capital_0 = backtest(price_df, ratio, init_drift_amt, freq)
        stats = compute_stats(timeline, capital_0)
        return (
            freq,
            stats["net_usd"],
            stats["final_pct"],
            stats["sharpe"],
            stats["min_drawdown"],
            stats["win_rate"],
            stats["trades_per_year"],
            stats["avg_hold_hrs"],
        )

    results = Parallel(n_jobs=n_jobs)(
        delayed(run)(freq) for freq in range(1, max_freq + 1)
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
    ratio = 10
    init_qty = 1
    max_freq = 96
    update_freq = 7

    df = prepare_df(
        "../data/price/drift_15m_90days.json",
        "../data/price/kmno_15m_90days.json",
        ratio,
    )

    timeline, capital_0 = backtest(df, ratio, init_qty, update_freq)
    stats = compute_stats(timeline, capital_0)

    equity_curve = timeline["equity"].ffill().dropna()
    returns = equity_curve.pct_change().dropna()
    rolling_vol = returns.rolling(30).std() * (252**0.5) * 100

    fig = make_subplots(
        rows=2,
        cols=1,
        subplot_titles=("PnL Curve", "Rolling Volatility (30-period)"),
        vertical_spacing=0.1,
        row_heights=[0.7, 0.3],
    )

    fig.add_trace(
        go.Scatter(
            x=equity_curve.index,
            y=equity_curve.values - capital_0,
            mode="lines",
            line=dict(color="#1f77b4", width=2),
            name="PnL",
        ),
        row=1,
        col=1,
    )

    fig.add_trace(
        go.Scatter(
            x=rolling_vol.index,
            y=rolling_vol.values,
            mode="lines",
            line=dict(color="#ff7f0e", width=1.5),
            name="Volatility %",
        ),
        row=2,
        col=1,
    )

    overall_vol = returns.std() * (252**0.5) * 100
    title_text = (
        f"Backtest Results | "
        f"Update Frequency: {update_freq * 15 / 60} hrs | "
        f"Return: {stats['final_pct']:.1f}% | "
        f"Sharpe: {stats['sharpe']:.1f} | "
        f"Drawdown: {stats['min_drawdown']:.1f}% | "
        f"Vol: {overall_vol:.1f}% | "
        f"Win Rate: {stats['win_rate']:.1f}%"
    )

    fig.update_layout(
        title=dict(text=title_text, font=dict(size=14)),
        showlegend=False,
        template="presentation",
        width=1200,
        height=700,
    )

    fig.update_yaxes(title_text="PnL ($)", row=1, col=1)
    fig.update_yaxes(title_text="Volatility (%)", row=2, col=1)
    fig.update_xaxes(title_text="Time", row=2, col=1)

    fig.show()

    # sweep_results = sweep_freq(df, ratio, init_qty, max_freq)
    # sweep_results.to_csv("backtest_fixed_size.csv", index=False)
