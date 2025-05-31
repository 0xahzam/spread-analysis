"use client";
import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Dot,
} from "recharts";

// Types
type CandleData = { ts: number; oracleClose: number };
type ApiResponse = { success: boolean; records: CandleData[] };
type MarketData = { timestamp: Date; drift: number; kmno: number; spread: number; zScore: number; signal: number };

// Constants
const API_ENDPOINTS = {
  DRIFT: "https://data.api.drift.trade/market/DRIFT-PERP/candles/15?limit=100",
  KMNO: "https://data.api.drift.trade/market/KMNO-PERP/candles/15?limit=100",
};

const CHART_STYLE = {
  backgroundColor: "white",
  border: "1px solid #e2e8f0",
  borderRadius: "6px",
  fontSize: "11px",
  boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
};

// Hook
const useMarketData = (priceRatio: number, zWindow: number, updateInterval: number) => {
  const [data, setData] = useState<MarketData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setError(null);
      const [driftRes, kmnoRes] = await Promise.all([fetch(API_ENDPOINTS.DRIFT), fetch(API_ENDPOINTS.KMNO)]);

      if (!driftRes.ok || !kmnoRes.ok) throw new Error("API fetch failed");

      const [{ records: driftData }, { records: kmnoData }] = (await Promise.all([
        driftRes.json(),
        kmnoRes.json(),
      ])) as [ApiResponse, ApiResponse];

      const alignedData: MarketData[] = [];
      for (const kmnoCandle of kmnoData) {
        const driftCandle = driftData.find(d => d.ts === kmnoCandle.ts);
        if (driftCandle) {
          alignedData.push({
            timestamp: new Date(kmnoCandle.ts * 1000),
            drift: driftCandle.oracleClose,
            kmno: kmnoCandle.oracleClose,
            spread: driftCandle.oracleClose - priceRatio * kmnoCandle.oracleClose,
            zScore: 0,
            signal: 0,
          });
        }
      }

      // Calculate indicators
      for (let i = 0; i < alignedData.length; i++) {
        if (i >= zWindow - 1) {
          let sum = 0;
          for (let j = i - zWindow + 1; j <= i; j++) sum += alignedData[j].spread;
          const mean = sum / zWindow;

          let variance = 0;
          for (let j = i - zWindow + 1; j <= i; j++) {
            variance += (alignedData[j].spread - mean) ** 2;
          }
          const std = Math.sqrt(variance / (zWindow - 1));
          alignedData[i].zScore = std > 0 ? (alignedData[i].spread - mean) / std : 0;
        }

        if (i >= 2) {
          const lagSpread = alignedData[i - 2].spread;
          alignedData[i].signal = lagSpread < 0 ? 1 : lagSpread > 0 ? -1 : 0;
        }
      }

      setData(alignedData.slice(-200));
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, updateInterval);
    return () => clearInterval(interval);
  }, [priceRatio, zWindow, updateInterval]);

  return { data, loading, error, refetch: fetchData };
};

// Utils
const formatChange = (current: number, previous: number) => {
  const change = (((current - previous) / previous) * 100).toFixed(2);
  return `${change.startsWith("-") ? "" : "+"}${change}%`;
};

const formatTime = (date: Date) =>
  date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });

// Components
const StatusCard = ({
  label,
  value,
  change,
  isLive,
  signal,
}: {
  label: string;
  value: number | string;
  change?: string;
  isLive?: boolean;
  signal?: number;
}) => (
  <div>
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs text-gray-500 font-medium tracking-wide uppercase">{label}</span>
      {isLive && (
        <div className="flex items-center gap-1">
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
          <span className="text-xs text-emerald-600 font-medium">LIVE</span>
        </div>
      )}
    </div>
    <div className="space-y-1">
      {signal !== undefined ? (
        <span
          className={`px-2 py-0.5 rounded text-xs font-medium ${
            signal === 1
              ? "bg-emerald-50 text-emerald-700"
              : signal === -1
                ? "bg-red-50 text-red-700"
                : "bg-gray-50 text-gray-700"
          }`}
        >
          {signal === 1 ? "LONG" : signal === -1 ? "SHORT" : "FLAT"}
        </span>
      ) : (
        <div className="text-xl font-mono text-gray-900 tabular-nums">
          {typeof value === "number" ? value.toFixed(4) : value}
        </div>
      )}
      {change && (
        <div className={`text-xs font-medium ${change.startsWith("+") ? "text-emerald-600" : "text-red-600"}`}>
          {change}
        </div>
      )}
    </div>
  </div>
);

const BaseChart = ({
  title,
  height = "h-64",
  children,
}: {
  title: string;
  height?: string;
  children: React.ReactElement;
}) => (
  <div className="space-y-3">
    <h3 className="text-sm font-medium text-gray-900">{title}</h3>
    <div className={height}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  </div>
);

// Main Component
const DriftKmnoDashboard = () => {
  const [config, setConfig] = useState({ priceRatio: 10, zWindow: 20, updateInterval: 60000 });
  const { data, loading, error, refetch } = useMarketData(config.priceRatio, config.zWindow, config.updateInterval);

  const chartData = useMemo(
    () =>
      data.map(d => ({
        ...d,
        time: formatTime(d.timestamp),
        timestamp: d.timestamp.getTime(),
      })),
    [data],
  );

  const [latest, previous] = [data[data.length - 1], data[data.length - 2]];
  const changes = useMemo(
    () =>
      latest && previous
        ? {
            drift: formatChange(latest.drift, previous.drift),
            kmno: formatChange(latest.kmno, previous.kmno),
          }
        : { drift: "+0.00%", kmno: "+0.00%" },
    [latest, previous],
  );

  if (loading && !data.length) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-200 border-t-blue-600 mx-auto" />
          <p className="text-sm text-gray-500">Loading market data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-sm text-red-600">Error: {error}</p>
          <button
            onClick={refetch}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-7xl mx-auto p-6 space-y-8">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-lg font-semibold text-gray-900">DRIFT-KMNO Spread Feed</h1>
            <p className="text-xs text-gray-500">Real-time convergence-divergence trading signals</p>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
            <span className="text-xs text-emerald-600 font-medium">LIVE</span>
          </div>
        </div>

        <div className="flex items-center gap-6 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Price Ratio:</span>
            <input
              type="number"
              value={config.priceRatio}
              onChange={e => setConfig(prev => ({ ...prev, priceRatio: parseFloat(e.target.value) || 10 }))}
              className="w-16 px-2 py-1 border border-gray-200 rounded-md text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
              min="1"
              max="50"
              step="0.1"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Z-Window:</span>
            <input
              type="number"
              value={config.zWindow}
              onChange={e => setConfig(prev => ({ ...prev, zWindow: parseInt(e.target.value) || 20 }))}
              className="w-16 px-2 py-1 border border-gray-200 rounded-md text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
              min="5"
              max="100"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-600">Update:</span>
            <select
              value={config.updateInterval}
              onChange={e => setConfig(prev => ({ ...prev, updateInterval: parseInt(e.target.value) }))}
              className="px-2 py-1 border border-gray-200 rounded-md text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value={30000}>30s</option>
              <option value={60000}>1min</option>
              <option value={300000}>5min</option>
            </select>
          </div>
          <button
            onClick={refetch}
            className="px-3 py-1 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 transition-colors"
          >
            Refresh
          </button>
        </div>

        <div className="grid grid-cols-5 gap-8">
          <StatusCard label="DRIFT Price" value={latest?.drift ?? 0} change={changes.drift} isLive />
          <StatusCard label="KMNO Price" value={latest?.kmno ?? 0} change={changes.kmno} isLive />
          <StatusCard label="Raw Spread" value={latest?.spread ?? 0} />
          <StatusCard label="Z-Score" value={latest?.zScore ?? 0} />
          <StatusCard label="Current Signal" value="" signal={latest?.signal ?? 0} />
        </div>

        <div className="grid grid-cols-2 gap-8">
          <BaseChart title="Price Chart">
            <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
              <XAxis
                dataKey="time"
                stroke="#64748b"
                fontSize={10}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "#64748b" }}
              />
              <YAxis stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: "#64748b" }} />
              <Tooltip contentStyle={CHART_STYLE} labelStyle={{ color: "#374151", fontSize: "11px" }} />
              <Line type="monotone" dataKey="drift" stroke="#3b82f6" strokeWidth={1.5} dot={false} name="DRIFT" />
              <Line type="monotone" dataKey="kmno" stroke="#ef4444" strokeWidth={1.5} dot={false} name="KMNO" />
            </LineChart>
          </BaseChart>

          <BaseChart title="Spread">
            <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
              <XAxis
                dataKey="time"
                stroke="#64748b"
                fontSize={10}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "#64748b" }}
              />
              <YAxis stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: "#64748b" }} />
              <Tooltip contentStyle={CHART_STYLE} labelStyle={{ color: "#374151", fontSize: "11px" }} />
              <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="2 2" strokeWidth={1} />
              <Line type="monotone" dataKey="spread" stroke="#8b5cf6" strokeWidth={1.5} dot={false} />
            </LineChart>
          </BaseChart>
        </div>

        <BaseChart title="Z-Score with Trading Signals" height="h-80">
          <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
            <XAxis
              dataKey="time"
              stroke="#64748b"
              fontSize={10}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "#64748b" }}
            />
            <YAxis stroke="#64748b" fontSize={10} axisLine={false} tickLine={false} tick={{ fill: "#64748b" }} />
            <Tooltip contentStyle={CHART_STYLE} labelStyle={{ color: "#374151", fontSize: "11px" }} />
            <ReferenceLine y={2} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
            <ReferenceLine y={-2} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} />
            <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="2 2" strokeWidth={1} />
            <Line
              type="monotone"
              dataKey="zScore"
              stroke="#10b981"
              strokeWidth={1.5}
              dot={(props: { cx: number; cy: number; payload: { zScore: number; signal: number } }) => {
                const { cx, cy, payload } = props;
                if (Math.abs(payload.zScore) > 2 && payload.signal !== 0) {
                  return (
                    <Dot
                      cx={cx}
                      cy={cy}
                      r={2.5}
                      fill={payload.signal === 1 ? "#22c55e" : "#ef4444"}
                      stroke="white"
                      strokeWidth={1}
                    />
                  );
                }
                return <></>;
              }}
            />
          </LineChart>
        </BaseChart>

        <div className="text-center">
          <p className="text-xs text-gray-400">
            Updated:{" "}
            {latest?.timestamp.toLocaleString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
              hour12: false,
            }) ?? "N/A"}
          </p>
        </div>
      </div>
    </div>
  );
};

export default DriftKmnoDashboard;
