import json
import numpy as np
import pandas as pd
from datetime import datetime
from statsmodels.tsa.stattools import adfuller
import plotly.graph_objects as go
from itertools import chain


def log(msg):
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}")


def load(path):
    with open(path) as f:
        d = json.load(f)
    df = pd.DataFrame(d["candles"])
    df["start"] = pd.to_datetime(df["start"].astype(int), unit="ms")
    df = df.drop_duplicates(subset="start")
    return df.set_index("start")


# Load price data
drift_df = load("../data/price/drift_15m_90days.json")
kmno_df = load("../data/price/kmno_15m_90days.json")

# Compute spread metrics
spreads = pd.DataFrame(
    {
        "drift": drift_df["oracleClose"].astype(float),
        "kmno": kmno_df["oracleClose"].astype(float),
    }
)
spreads["diff"] = spreads["drift"] - spreads["kmno"]
spreads["ratio"] = spreads["drift"] / spreads["kmno"]
spreads["log_diff"] = np.log(spreads["drift"]) - np.log(spreads["kmno"])

# Rolling z-score normalization (20-bar window)
window = 20
for col in ["diff", "ratio", "log_diff"]:
    m = spreads[col].rolling(window).mean()
    s = spreads[col].rolling(window).std()
    spreads[f"{col}_z"] = (spreads[col] - m) / s

# ADF stationarity check on log-diff
# pval = adfuller(spreads["log_diff"].dropna())[1]
# log(f"ADF p-value (log_diff): {pval:.5f}")

# Divergence-convergence event detection
z = spreads["log_diff_z"].values
times = spreads.index
n = len(z)

threshold = 2.0  # divergence trigger
conv_thresh = 0.5  # convergence threshold
look_forward = 96  # 24h window (15min bars)

div_idx = np.where(np.abs(z) > threshold)[0]
events = []
last_conv_idx = -1

for i in div_idx:
    if i <= last_conv_idx:
        continue

    end = min(i + look_forward + 1, n)
    fwd = z[i + 1 : end]

    conv_pos = np.where(np.abs(fwd) < conv_thresh)[0]
    conv_status = bool(conv_pos.size)

    t_conv = None
    z_conv = None

    if conv_status:
        j = i + 1 + conv_pos[0]
        last_conv_idx = j
        t_conv = times[j]
        z_conv = float(z[j])

    events.append(
        {
            "timestamp": times[i],
            "entry_z": float(z[i]),
            "direction": "pos" if z[i] > 0 else "neg",
            "converged": conv_status,
            "time_to_conv": (conv_pos[0] * 15 / 60) if conv_status else None,
            "max_excursion": float(np.max(np.abs(fwd))) if fwd.size else None,
            "t_conv": t_conv,
            "z_conv": z_conv,
        }
    )


events_df = pd.DataFrame(events)
log(f"Events: {len(events_df)}")
log(f"Convergence Rate: {events_df['converged'].mean() * 100:.2f}%")
log(f"Avg Time to Converge (hrs): {events_df['time_to_conv'].mean():.2f}")
log(f"Worst Excursion: {events_df['max_excursion'].max():.2f}")


# Plot: log_diff_z with divergence/convergence markers
converged = events_df[events_df["converged"]].copy()

fig = go.Figure()

fig.add_trace(
    go.Scatter(
        x=spreads.index,
        y=spreads["log_diff_z"],
        mode="lines",
        name="log_diff_z",
        line=dict(color="gray", width=1.5),
    )
)

fig.add_hline(y=threshold, line=dict(dash="dash", color="red"))
fig.add_hline(y=-threshold, line=dict(dash="dash", color="red"))
fig.add_hline(y=0.0, line=dict(dash="dot", color="black"))

vrects = [
    dict(
        type="rect",
        xref="x",
        yref="paper",
        x0=row.timestamp,
        x1=row.t_conv,
        y0=0,
        y1=1,
        fillcolor="rgba(50, 200, 150, 0.15)",
        line_width=0,
        layer="below",
    )
    for row in converged.itertuples()
]
fig.update_layout(shapes=vrects)

lines_x = list(
    chain.from_iterable([[r.timestamp, r.t_conv, None] for r in converged.itertuples()])
)
lines_y = list(
    chain.from_iterable([[r.entry_z, r.z_conv, None] for r in converged.itertuples()])
)

fig.add_trace(
    go.Scatter(
        x=lines_x,
        y=lines_y,
        mode="lines",
        line=dict(color="mediumseagreen", width=2),
        showlegend=False,
        hoverinfo="skip",
    )
)

fig.add_trace(
    go.Scatter(
        x=converged["t_conv"],
        y=converged["z_conv"],
        mode="markers",
        name="Converged",
        marker=dict(symbol="circle", size=6, color="green"),
        showlegend=False,
    )
)

fig.add_trace(
    go.Scatter(
        x=events_df["timestamp"],
        y=events_df["entry_z"],
        mode="markers",
        name="Divergence",
        marker=dict(symbol="x", size=6, color="orange"),
    )
)

fig.update_layout(
    title="Z-Score of Log-Price Spread (DRIFT vs KMNO) with Divergence-Convergence Windows",
    height=600,
    template="plotly_white",
    showlegend=True,
    xaxis_title="Time",
    yaxis_title="log_diff_z",
)

fig.show()
