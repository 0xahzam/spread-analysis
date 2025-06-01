import streamlit as st
import pandas as pd
import plotly.graph_objects as go
from reproduce import load_sweep, prepare_df, backtest, compute_stats

st.set_page_config(layout="wide")
st.title("DRIFT/KMNO Convergence Arbitrage Dashboard")

st.markdown("""
### Strategy Overview
- **Markets:** DRIFT/USD, KMNO/USD (Perpetuals)
- **Data:** 15m oracle prices (90 days)
- **Ratio Fixed:** 1 DRIFT : 10 KMNO
- **Signal:** Spread = DRIFT - 10 * KMNO (flip triggers trade)
- **Execution:** Taker orders on signal flip (lagged by 1 bar)
- **Fees:** 10 bps taker per leg
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

equity = timeline_df["equity"].ffill()
cum_pnl = equity - initial_capital

st.markdown("### Backtest Summary")
st.markdown(f"""
- **Rebalance every:** {freq} bars ({freq * 15} min)  
- **Initial Notional:** 1 DRIFT, 10 KMNO  
- **Initial Capital (USD):** {initial_capital:.2f}
""")

metrics_df = pd.DataFrame(stats.items(), columns=["Metric", "Value"])
metrics_df["Value"] = metrics_df["Value"].map("{:.2f}".format)
st.dataframe(metrics_df, use_container_width=True)

st.markdown("---")
st.markdown("### Equity Curve & Volatility")

fig = go.Figure()
fig.add_trace(
    go.Scatter(x=timeline_df.index, y=equity, name="Equity", line=dict(color="#1f77b4"))
)
fig.add_trace(
    go.Scatter(
        x=timeline_df.index,
        y=cum_pnl,
        name="Cumulative PnL",
        line=dict(color="#EF553B", dash="dash"),
    )
)
fig.update_layout(
    height=400, margin=dict(t=20, b=20), xaxis_title="Time", yaxis_title="USD"
)
st.plotly_chart(fig, use_container_width=True)

pct_change = equity.pct_change().fillna(0)
vol_rolling = pct_change.rolling(30).std()

fig_vol = go.Figure()
fig_vol.add_trace(
    go.Scatter(
        x=timeline_df.index,
        y=100 * pct_change,
        name="% Change",
        line=dict(color="#FFA15A"),
    )
)
fig_vol.add_trace(
    go.Scatter(
        x=timeline_df.index,
        y=100 * vol_rolling,
        name="30-Bar Rolling Vol",
        line=dict(color="#FF6692", dash="dot"),
    )
)
fig_vol.update_layout(
    height=300, xaxis_title="Time", yaxis_title="Volatility (%)", yaxis_tickformat=".2f"
)
st.plotly_chart(fig_vol, use_container_width=True)

st.markdown("---")
st.markdown("### Prices & Spread")

df = price_df.loc[timeline_df.index].copy()
df["kmno_scaled"] = df["kmno"] * ratio
spread_vol = df["spread"].pct_change().fillna(0) * 100

fig_spread = go.Figure()
fig_spread.add_trace(
    go.Scatter(
        x=df.index,
        y=df["spread"],
        name="Spread (DRIFT − 10×KMNO)",
        line=dict(color="#EF553B"),
    )
)
fig_spread.add_trace(
    go.Scatter(
        x=df.index,
        y=spread_vol,
        name="Spread Volatility",
        line=dict(color="#AB63FA", dash="dot"),
        yaxis="y2",
    )
)
fig_spread.update_layout(
    height=300,
    margin=dict(t=20),
    yaxis=dict(title="USD"),
    yaxis2=dict(title="%", overlaying="y", side="right"),
)
st.plotly_chart(fig_spread, use_container_width=True)

fig_price = go.Figure()
fig_price.add_trace(
    go.Scatter(x=df.index, y=df["drift"], name="DRIFT", line=dict(color="#1f77b4"))
)
fig_price.add_trace(
    go.Scatter(x=df.index, y=df["kmno"], name="KMNO", line=dict(color="#00cc96"))
)
fig_price.add_trace(
    go.Scatter(
        x=df.index, y=10 * df["kmno"], name="10*KMNO", line=dict(color="#cc0092")
    )
)
fig_price.update_layout(height=300, margin=dict(t=20), yaxis_title="USD")
st.plotly_chart(fig_price, use_container_width=True)

st.markdown("---")
st.markdown("### Trade Log & Distribution")

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

summary = (
    trade_log["signal"]
    .value_counts()
    .rename({1: "Long DRIFT", -1: "Short DRIFT"})
    .to_frame("Count")
)
st.markdown("**Trade Direction Distribution**")
st.dataframe(summary, use_container_width=True)

st.markdown("---")
st.markdown("### Performance by Rebalance Frequency")

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
                x=df_results["update_freq"],
                y=df_results[key],
                mode="lines+markers",
                line=dict(color=color),
            )
        )
        fig.update_layout(
            height=300,
            title=title,
            xaxis_title="Rebalance Frequency (bars)",
            yaxis_title=unit,
        )
        [col1, col2][j].plotly_chart(fig, use_container_width=True)

st.markdown("""
---
**Backtest Engine:** Custom Python  
**Oracle Feed:** Drift oracle (via JSON dumps)  
**Data Range:** Last 90 days, 15m interval  
""")
