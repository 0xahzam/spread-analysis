import requests
import json
import time
from datetime import datetime


def log(msg):
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}")


def fetch_drift_candles(outfile, market=None, resolution=60, start=None, end=None):
    assert start and end and market, "Must specify start and end timestamps (ms)"

    url = "https://mainnet-beta.api.drift.trade/tv/history"
    headers = {
        "origin": "https://app.drift.trade",
        "referer": "https://app.drift.trade",
    }

    interval_ms = resolution * 60 * 1000
    step = 2000 * interval_ms

    out = []
    for t in range(start, end, step):
        fr, to = t, min(t + step, end)
        log(f"Fetching {fr} → {to}")
        r = requests.get(
            url,
            headers=headers,
            params={
                "marketIndex": market,
                "marketType": "perp",
                "resolution": resolution,
                "from": fr,
                "to": to,
            },
        )
        candles = r.json().get("candles", [])
        log(f"Fetched {len(candles)} candles")
        out.extend(candles)
        time.sleep(0.2)

    log(f"Total candles: {len(out)}")
    with open(outfile, "w") as f:
        json.dump({"candles": out}, f, indent=2)
    log(f"Saved to {outfile}")


# fetch_drift_candles(
#     outfile="../data/price/kmno_15m_90d.json",
#     market=28,
#     resolution=15,
#     start=1739740800000,
#     end=1747516800000,
# )
