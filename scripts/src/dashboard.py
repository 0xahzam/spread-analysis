import streamlit as st
import pandas as pd
import plotly.graph_objects as go
from backtest import load_sweep, prepare_df, backtest, compute_stats, sweep_freq

st.set_page_config(layout="wide")
st.title("DRIFT/KMNO Convergence Arbitrage Dashboard")

st.markdown("""
Pool: DRIFT/USD and KMNO/USD PERPS  
Data: Oracle prices (15m candles, 90 days)
""")

st.markdown("""
## Strategy Logic

This strategy trades DRIFT vs KMNO based on spread mean reversion.  
We fix the unit ratio at **1 DRIFT : 10 KMNO** and rebalance positions when the spread flips sign.

- Long DRIFT / Short KMNO when DRIFT is underpriced (`spread < 0`)  
- Short DRIFT / Long KMNO when DRIFT is overpriced (`spread > 0`)

Trades execute on signal flips using prior-bar signals to avoid lookahead. Position sizing is dynamic and based on capital and prices at each trade.
""")

ratio = 10
init_drift_amt = 1

price_df = prepare_df(
    "../data/price/drift_15m_90days.json",
    "../data/price/kmno_15m_90days.json",
    ratio,
)

freq = st.slider("Rebalance Frequency (bars)", 1, 96, 4)

timeline_df, initial_capital = backtest(price_df, ratio, init_drift_amt, freq)
stats = compute_stats(timeline_df, initial_capital)

st.markdown(f"""
## Backtest Summary

- Rebalance frequency: **{freq} bars** = **{freq * 15} minutes**  
- Starting notional: **1 DRIFT, 10 KMNO**  
- Sizing, capital, and equity updated per trade.
""")

metrics_df = pd.DataFrame(stats.items(), columns=["Metric", "Value"])
metrics_df["Value"] = metrics_df["Value"].map("{:.2f}".format)
st.dataframe(metrics_df, use_container_width=True)

if not timeline_df.empty:
    st.markdown("## Capital Growth & Realized PnL")

    equity = timeline_df["equity"].ffill()
    cum_pnl = equity - initial_capital

    fig = go.Figure()
    fig.add_trace(
        go.Scatter(
            x=timeline_df.index,
            y=equity,
            mode="lines",
            line=dict(color="#1f77b4"),
            name="Equity",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=timeline_df.index,
            y=cum_pnl,
            mode="lines",
            line=dict(color="#EF553B", dash="dash"),
            name="Cumulative PnL",
        )
    )
    fig.add_trace(
        go.Scatter(
            x=[timeline_df.index[0], timeline_df.index[-1]],
            y=[initial_capital, initial_capital],
            mode="lines",
            line=dict(color="gray", dash="dot"),
            name="Starting Capital",
        )
    )
    fig.update_layout(
        height=400, margin=dict(t=20, b=20), xaxis_title="Time", yaxis_title="USD"
    )
    st.plotly_chart(fig, use_container_width=True)


st.markdown("## Trade Log")

trade_log = timeline_df[timeline_df["is_exit"] | timeline_df["is_entry"]].copy()
cols = [
    "signal",
    "qty_drift",
    "qty_kmno",
    "pnl_drift",
    "pnl_kmno",
    "funding_drift",
    "funding_kmno",
    "fee",
    "equity",
]
st.dataframe(trade_log[cols], use_container_width=True, height=400)

st.markdown("## Metric Trends by Rebalance Frequency")

df_results = load_sweep()

metric_groups = [
    ("net_usd", "Net PnL ($)", "$", "#636EFA"),
    ("final_pct", "Final Return (%)", "%", "#EF553B"),
    ("sharpe", "Sharpe Ratio", "", "#00CC96"),
    ("min_drawdown", "Max Drawdown (%)", "%", "#AB63FA"),
    ("win_rate", "Win Rate (%)", "%", "#FFA15A"),
    ("trades_per_year", "Trades Per Year", "", "#19D3F3"),
    ("avg_hold_hrs", "Avg Hold Duration (hrs)", "hrs", "#FF6692"),
]

for i in range(0, len(metric_groups), 2):
    col1, col2 = st.columns(2)
    for j, (key, title, unit, color) in enumerate(metric_groups[i : i + 2]):
        fig = go.Figure(
            go.Scatter(
                x=df_results.index,
                y=df_results[key],
                mode="lines+markers",
                line=dict(color=color),
                name=key,
            )
        )
        fig.update_layout(
            height=300,
            margin=dict(t=30, b=30),
            title=title,
            xaxis_title="Rebalance Frequency (bars)",
            yaxis_title=unit,
        )
        [col1, col2][j].plotly_chart(fig, use_container_width=True)
