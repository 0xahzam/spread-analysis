import json
import pandas as pd
import numpy as np
from plotly.subplots import make_subplots
import plotly.graph_objects as go


# read JSON file of OHLCV ‘candles’, parse timestamps and remove duplicates
def load_candles(path):
    with open(path) as f:
        d = json.load(f)
    df = pd.DataFrame(d["candles"])
    df["start"] = pd.to_datetime(df["start"].astype(int), unit="ms")
    return df.drop_duplicates("start").set_index("start")["oracleClose"].astype(float)


# load DRIFT and KMNO oracle‐price series, compute spread, signal, and shift to avoid lookahead
# spread = drift_price − ratio*kmno_price; positive → DRIFT rich, negative → DRIFT cheap
# signal = +1 to long DRIFT/short KMNO when spread negative, −1 when spread positive
# use yesterday’s signal for trading (last tick/bar)
def prepare_df(drift_path, kmno_path, ratio):
    drift = load_candles(drift_path)
    kmno = load_candles(kmno_path)

    price_df = pd.concat([drift, kmno], axis=1, keys=["drift", "kmno"]).dropna()
    price_df["spread"] = price_df["drift"] - ratio * price_df["kmno"]
    price_df["signal"] = -np.sign(price_df["spread"])
    price_df["signal_yest"] = price_df["signal"].shift(1)

    return price_df.dropna(subset=["signal_yest"])


# backtest loop using tuple state and clear prints
# skip flat signal, open initial position, flip on signal change, compute PnL, and final close
def backtest(price_df, ratio, capital, rebalance_freq, VERBOSE=True):
    position = None
    trades = []

    for i in range(0, len(price_df), rebalance_freq):
        row = price_df.iloc[i]

        # timestamp, signal
        timestamp = row.name
        signal = int(row.signal_yest)

        if signal == 0:  # skip flat signal (no position)
            continue

        if not position:  # open first position: size USD legs in fixed ratio
            basket_price = row.drift + ratio * row.kmno
            qty_unit = capital / basket_price
            position = (
                timestamp,
                signal,
                row.drift,
                row.kmno,
                qty_unit,
                ratio * qty_unit,
                capital,
            )
            if VERBOSE:
                print(f"{timestamp}\tOPEN\ts={signal}\t\t\tcapital=${capital:.2f}")
            continue

        (
            entry_time,
            entry_signal,
            entry_drift,
            entry_kmno,
            qty_drift,
            qty_kmno,
            capital_at_entry,
        ) = position

        if signal == entry_signal:  # if signal unchanged, hold current position
            continue

        # on signal flip: close existing position and compute PnL
        # signal * quantity * (current price - open price)
        drift_pnl = entry_signal * qty_drift * (row.drift - entry_drift)
        kmno_pnl = -entry_signal * qty_kmno * (row.kmno - entry_kmno)
        total_pnl = drift_pnl + kmno_pnl
        capital += total_pnl

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

        # open new position sized to current capital and fair-value basket
        basket_price = row.drift + ratio * row.kmno
        qty_unit = capital / basket_price
        position = (
            timestamp,
            signal,
            row.drift,
            row.kmno,
            qty_unit,
            ratio * qty_unit,
            capital,
        )

        if VERBOSE:
            print(f"{timestamp}\tOPEN\ts={signal}\t\t\tcapital=${capital:.2f}")

    if position:  # force final close at end of data if still in position
        (
            entry_time,
            entry_signal,
            entry_drift,
            entry_kmno,
            qty_drift,
            qty_kmno,
            capital_at_entry,
        ) = position
        row = price_df.iloc[-1]
        timestamp = row.name

        drift_pnl = entry_signal * qty_drift * (row.drift - entry_drift)
        kmno_pnl = -entry_signal * qty_kmno * (row.kmno - entry_kmno)
        total_pnl = drift_pnl + kmno_pnl
        capital += total_pnl

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

    return pd.DataFrame(
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


if __name__ == "__main__":
    ratio = 10  # target 1 DRIFT vs 10 KMNO in synthetic basket
    initial_capital = 1 + ratio  # USD deployed = $1 + $10 = $11

    price_df = prepare_df(
        "../data/price/drift_15m_90days.json",
        "../data/price/kmno_15m_90days.json",
        ratio,
    )

    results = []

    for update_freq in range(1, 97):  # 1 to 96 (15min to 24h)
        # verbose=true for logs
        trades_df = backtest(
            price_df, ratio, initial_capital, update_freq, VERBOSE=False
        )
        # stats
        net_usd = trades_df["total_pnl_usd"].sum()
        final_pct = net_usd / initial_capital * 100
        total_days = (price_df.index[-1] - price_df.index[0]).total_seconds() / 86400
        trades_per_year = len(trades_df) / total_days * 365
        returns = trades_df["pnl_pct"]

        if len(returns) > 0:
            # sharpe based on per-trade returns
            avg_hours = (
                trades_df["exit_time"] - trades_df["entry_time"]
            ).dt.total_seconds().mean() / 3600
            rf_annual = 0.0406
            rf_per_trade = rf_annual * (avg_hours / 8760)
            excess_ret = returns - rf_per_trade
            std = excess_ret.std()
            sharpe = (
                (excess_ret.mean() / std * np.sqrt(8760 / avg_hours))
                if std > 1e-8
                else 0
            )
            # equity curve and drawdown
            equity = trades_df["total_pnl_usd"].cumsum() + initial_capital
            drawdown = equity / equity.cummax() - 1
            min_dd = drawdown.min() * 100
            # win rate
            win_rate = (returns > 0).mean() * 100
        else:
            sharpe = min_dd = win_rate = avg_hours = 0

        results.append(
            (
                update_freq,
                net_usd,
                final_pct,
                sharpe,
                min_dd,
                win_rate,
                trades_per_year,
                avg_hours,
            )
        )

    df_results = pd.DataFrame(
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

    # fig.write_image("backtest.png", width=1920, height=1080, scale=2)
