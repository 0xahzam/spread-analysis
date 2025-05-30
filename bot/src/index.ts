import {
  DriftClient,
  Wallet,
  initialize,
  BulkAccountLoader,
  PerpMarkets,
  OrderType,
  PositionDirection,
  BASE_PRECISION,
  QUOTE_PRECISION,
  BN,
} from "@drift-labs/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection, config } from "./config";
import logger from "./utils";

// Trading parameters
const DRIFT_QUANTITY = 10; // DRIFT position size
const KMNO_QUANTITY = 100; // KMNO position size
const PRICE_RATIO = 10; // Price ratio for spread calculation
const SIGNAL_LAG_PERIODS = 2; // Signal lag periods
const CYCLE_INTERVAL_MS = 900_000; // 15min cycle (900k ms)
const SIMULATION_MODE = false; // Simulation mode flag
const ENV = "mainnet-beta";

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Core types
type Signal = -1 | 0 | 1; // Signal: short/flat/long
type Position = { drift: number; kmno: number; signal: Signal }; // Position state
type CandleData = { oracleClose: number }; // Price data from API

// Global state
let currentPosition: Position | null = null;
let driftClient: DriftClient;
let marketMap: Map<string, any>;
let cycleCount = 0;

// Cycle protection
let isCycleRunning = false;
let cycleInterval: NodeJS.Timeout | null = null;

// High precision timing
const getHighResTime = () => process.hrtime.bigint();
let cycleStartTime: bigint;

// Utility functions
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryWithBackoff = async <T>(fn: () => Promise<T>, maxRetries: number = MAX_RETRIES): Promise<T> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `[RETRY] Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms: ${(error as Error).message}`,
      );
      await sleep(delay);
    }
  }
  throw new Error("Retry logic failed unexpectedly");
};

// Position reconciliation
const reconcilePositionState = async () => {
  if (SIMULATION_MODE) return;

  try {
    const positions = driftClient.getUser().getUserAccount().perpPositions;
    let drift = 0;
    let kmno = 0;

    for (const pos of positions) {
      if (pos.baseAssetAmount.eq(new BN(0))) continue;

      const market = Array.from(marketMap.values()).find(m => m.marketIndex === pos.marketIndex);
      if (!market) continue;

      const size = Number(pos.baseAssetAmount) / Number(BASE_PRECISION);

      if (market.baseAssetSymbol === "DRIFT") {
        drift = size;
      }
      if (market.baseAssetSymbol === "KMNO") {
        kmno = size;
      }
    }

    if (drift !== 0 || kmno !== 0) {
      // Determine signal from actual positions
      let signal: Signal = 0;
      if (drift > 0 && kmno < 0) signal = 1;
      else if (drift < 0 && kmno > 0) signal = -1;

      currentPosition = { drift, kmno, signal };
      logger.info(`[RECONCILE] Restored position state: DRIFT=${drift} KMNO=${kmno} Signal=${signal}`);
    } else {
      currentPosition = null;
      logger.info(`[RECONCILE] No existing positions found`);
    }
  } catch (error) {
    logger.error(`[RECONCILE] Failed to reconcile position state: ${(error as Error).message}`);
  }
};

// Logging functions
const logAccountState = async () => {
  if (SIMULATION_MODE) return;

  try {
    const user = driftClient.getUser();
    const [totalCollateral, freeCollateral, unrealizedPnL] = [
      user.getTotalCollateral(),
      user.getFreeCollateral(),
      user.getUnrealizedPNL(),
    ].map(n => Number(n) / Number(QUOTE_PRECISION));

    if (!totalCollateral || !freeCollateral || !unrealizedPnL) return;

    logger.info(
      `[ACCOUNT] Collateral=${totalCollateral.toFixed(2)} Free=${freeCollateral.toFixed(2)} PnL=${unrealizedPnL.toFixed(4)}`,
    );
  } catch (error) {
    logger.warn(`[ACCOUNT] Error: ${(error as Error).message}`);
  }
};

const logActualPositions = async () => {
  if (SIMULATION_MODE) {
    const pos = currentPosition
      ? `DRIFT=${currentPosition.drift} KMNO=${currentPosition.kmno} Signal=${currentPosition.signal}`
      : "Flat";
    return logger.info(`[POSITIONS] ${pos} [SIM]`);
  }

  try {
    const positions = driftClient.getUser().getUserAccount().perpPositions;

    let drift = 0;
    let kmno = 0;
    let driftPnL = 0;
    let kmnoPnL = 0;

    for (const pos of positions) {
      if (pos.baseAssetAmount.eq(new BN(0))) continue;

      const market = Array.from(marketMap.values()).find(m => m.marketIndex === pos.marketIndex);
      if (!market) continue;

      const size = Number(pos.baseAssetAmount) / Number(BASE_PRECISION);
      const pnl = Number(driftClient.getUser().getUnrealizedPNL(false, pos.marketIndex)) / Number(QUOTE_PRECISION);

      if (market.baseAssetSymbol === "DRIFT") {
        drift = size;
        driftPnL = pnl;
      }
      if (market.baseAssetSymbol === "KMNO") {
        kmno = size;
        kmnoPnL = pnl;
      }
    }

    logger.info(
      `[POSITIONS] DRIFT=${drift.toFixed(1)}(${driftPnL.toFixed(4)}) KMNO=${kmno.toFixed(1)}(${kmnoPnL.toFixed(4)}) Total=${(driftPnL + kmnoPnL).toFixed(4)}`,
    );
  } catch (error) {
    logger.warn(`[POSITIONS] Error: ${(error as Error).message}`);
  }
};

// API fetch with retry
const fetchCandleData = async (symbol: string): Promise<CandleData[]> => {
  return retryWithBackoff(async () => {
    const fetchStart = getHighResTime();
    const response = await fetch(
      `https://data.api.drift.trade/market/${symbol}/candles/15?limit=${SIGNAL_LAG_PERIODS + 1}`,
    );
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = (await response.json()) as any;
    logger.debug(`[API] ${symbol} fetch completed in ${(Number(getHighResTime() - fetchStart) / 1e6).toFixed(1)}ms`);
    return data.records;
  });
};

// Order placement with retry
const placeOrder = async (market: string, direction: PositionDirection, quantity: number, reduceOnly = false) => {
  const orderStart = getHighResTime();
  const action = reduceOnly ? "CLOSE" : "OPEN";
  const directionStr = direction === PositionDirection.LONG ? "LONG" : "SHORT";

  logger.info(`[ORDER] ${action} ${market} ${directionStr} ${quantity} ${SIMULATION_MODE ? "[SIM]" : "[LIVE]"}`);
  if (SIMULATION_MODE) return;

  return retryWithBackoff(async () => {
    try {
      const marketConfig = marketMap.get(market);
      if (!marketConfig) throw new Error(`Market config not found for ${market}`);

      const tx = await driftClient.placePerpOrder({
        orderType: OrderType.MARKET,
        marketIndex: marketConfig.marketIndex,
        direction,
        baseAssetAmount: new BN(quantity).mul(BASE_PRECISION),
        reduceOnly,
      });

      logger.info(`[ORDER] Transaction signature: ${tx}`);
      logger.info(`[ORDER] Explorer link: https://solscan.io/tx/${tx}`);
      logger.info(
        `[ORDER] ${action} ${market} ${directionStr} ${quantity} completed in ${(Number(getHighResTime() - orderStart) / 1e6).toFixed(1)}ms`,
      );
      return tx;
    } catch (error) {
      logger.error(`[ORDER] ${action} ${market} ${directionStr} ${quantity} FAILED: ${(error as Error).message}`);
      throw error;
    }
  });
};

// Position close
const closePosition = async () => {
  if (!currentPosition) return logger.debug(`[CLOSE] No position to close`);

  logger.info(
    `[CLOSE] Closing position DRIFT=${currentPosition.drift} KMNO=${currentPosition.kmno} Signal=${currentPosition.signal}`,
  );

  try {
    const promises = [];

    if (currentPosition.drift !== 0) {
      promises.push(
        placeOrder(
          "DRIFT",
          currentPosition.drift > 0 ? PositionDirection.SHORT : PositionDirection.LONG,
          Math.abs(currentPosition.drift),
          true,
        ),
      );
    }

    if (currentPosition.kmno !== 0) {
      promises.push(
        placeOrder(
          "KMNO",
          currentPosition.kmno > 0 ? PositionDirection.SHORT : PositionDirection.LONG,
          Math.abs(currentPosition.kmno),
          true,
        ),
      );
    }

    await Promise.all(promises);
    currentPosition = null; // Only clear position after BOTH close orders succeed
    logger.info(`[CLOSE] Successfully closed position`);
  } catch (error) {
    logger.error(`[CLOSE] Failed to close position: ${(error as Error).message}`);
    // Don't clear currentPosition on failure to maintain state consistency
    throw error;
  }
};

// Position open
const openPosition = async (signal: Signal) => {
  if (signal === 0) return logger.debug(`[OPEN] Signal is 0, no position to open`);

  const driftDirection = signal > 0 ? PositionDirection.LONG : PositionDirection.SHORT;
  const kmnoDirection = signal > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
  const signalStr = signal > 0 ? "LONG" : "SHORT";

  logger.info(
    `[OPEN] Opening ${signalStr} spread: DRIFT ${DRIFT_QUANTITY} ${driftDirection === PositionDirection.LONG ? "LONG" : "SHORT"} KMNO ${KMNO_QUANTITY} ${kmnoDirection === PositionDirection.LONG ? "LONG" : "SHORT"}`,
  );

  try {
    await Promise.all([
      placeOrder("DRIFT", driftDirection, DRIFT_QUANTITY),
      placeOrder("KMNO", kmnoDirection, KMNO_QUANTITY),
    ]);

    currentPosition = {
      drift: signal * DRIFT_QUANTITY,
      kmno: -signal * KMNO_QUANTITY,
      signal,
    };

    logger.info(`[OPEN] Successfully opened ${signalStr} spread position`);
  } catch (error) {
    logger.error(`[OPEN] Failed to open ${signalStr} spread: ${(error as Error).message}`);
    // Don't set currentPosition on failure to avoid inconsistent state
    throw error;
  }
};

// Main trading loop with cycle protection
const executeTradingCycle = async () => {
  if (isCycleRunning) {
    logger.warn(`[CYCLE] Previous cycle still running, skipping cycle ${cycleCount + 1}`);
    return;
  }

  isCycleRunning = true;
  cycleStartTime = getHighResTime();
  cycleCount++;

  logger.info(`[CYCLE] Starting cycle ${cycleCount}`);

  try {
    // Parallel data fetch
    const dataFetchStart = getHighResTime();
    const [driftCandles, kmnoCandles] = await Promise.all([
      fetchCandleData("DRIFT-PERP"),
      fetchCandleData("KMNO-PERP"),
    ]);
    const dataFetchTime = Number(getHighResTime() - dataFetchStart) / 1e6;

    // Data validation
    if (driftCandles.length < SIGNAL_LAG_PERIODS + 1 || kmnoCandles.length < SIGNAL_LAG_PERIODS + 1) {
      return logger.warn(`[CYCLE] Insufficient data: DRIFT=${driftCandles.length} KMNO=${kmnoCandles.length} candles`);
    }

    // Extract lagged prices for signal calculation
    const driftPrice = driftCandles[SIGNAL_LAG_PERIODS]!.oracleClose;
    const kmnoPrice = kmnoCandles[SIGNAL_LAG_PERIODS]!.oracleClose;
    const spread = driftPrice - PRICE_RATIO * kmnoPrice;
    const signal: Signal = spread < 0 ? 1 : spread > 0 ? -1 : 0;
    const signalStr = signal === 1 ? "LONG" : signal === -1 ? "SHORT" : "FLAT";

    logger.info(
      `[MARKET] DRIFT=${driftPrice.toFixed(4)} KMNO=${kmnoPrice.toFixed(4)} Spread=${spread.toFixed(4)} Signal=${signalStr} DataFetch=${dataFetchTime.toFixed(1)}ms`,
    );

    // Trading logic
    const currentSignal = currentPosition?.signal || 0;
    const currentSignalStr = currentSignal === 1 ? "LONG" : currentSignal === -1 ? "SHORT" : "FLAT";

    if (!currentPosition && signal !== 0) {
      logger.info(`[STRATEGY] State transition: FLAT -> ${signalStr}`);
      await openPosition(signal);
    } else if (currentPosition && currentPosition.signal !== signal) {
      logger.info(`[STRATEGY] State transition: ${currentSignalStr} -> ${signalStr}`);
      await closePosition();
      if (signal !== 0) await openPosition(signal);
    } else {
      logger.info(`[STRATEGY] Holding position: ${currentSignalStr}`);
    }

    await logActualPositions();
    await logAccountState();

    logger.info(
      `[CYCLE] Cycle ${cycleCount} completed in ${(Number(getHighResTime() - cycleStartTime) / 1e6).toFixed(1)}ms`,
    );
  } catch (error) {
    logger.error(`[CYCLE] Cycle ${cycleCount} failed: ${(error as Error).message}`);
  } finally {
    isCycleRunning = false;
  }
};

// System initialization
const initializeSystem = async () => {
  logger.info(`[INIT] Initializing trading system`);

  const sdk = initialize({ env: ENV });
  const accountLoader = new BulkAccountLoader(connection, "processed", 1000);

  // Key parsing with validation
  let secretKey: Uint8Array;
  try {
    secretKey = config.PRIVATE_KEY.startsWith("[")
      ? new Uint8Array(JSON.parse(config.PRIVATE_KEY))
      : Buffer.from(config.PRIVATE_KEY, "base64");
    logger.info(`[INIT] Private key parsed successfully`);
  } catch (error) {
    throw new Error(`Failed to parse private key: ${(error as Error).message}`);
  }

  const wallet = new Wallet(Keypair.fromSecretKey(secretKey));
  logger.info(`[INIT] Wallet address: ${wallet.publicKey.toString()}`);

  driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdk.DRIFT_PROGRAM_ID),
    accountSubscription: {
      type: "websocket",
      //@ts-ignore
      accountLoader,
    },
  });

  logger.info(`[INIT] Connecting to Drift protocol`);
  await driftClient.subscribe();

  const user = driftClient.getUser();
  await user.exists();

  marketMap = new Map(PerpMarkets[ENV].map(market => [market.baseAssetSymbol, market]));

  const driftMarket = marketMap.get("DRIFT");
  const kmnoMarket = marketMap.get("KMNO");

  if (!driftMarket || !kmnoMarket) throw new Error("Required markets DRIFT or KMNO not found");

  logger.info(`[INIT] Markets loaded: DRIFT(${driftMarket.marketIndex}) KMNO(${kmnoMarket.marketIndex})`);
  logger.info(
    `[INIT] Trading parameters: DRIFT_QTY=${DRIFT_QUANTITY} KMNO_QTY=${KMNO_QUANTITY} RATIO=${PRICE_RATIO} LAG=${SIGNAL_LAG_PERIODS}`,
  );

  // Reconcile position state on startup
  await reconcilePositionState();

  logger.info(
    `[INIT] System ready - Mode: ${SIMULATION_MODE ? "SIMULATION" : "LIVE"} - Cycle: ${CYCLE_INTERVAL_MS / 1000}s`,
  );
};

// Clean shutdown
let isShuttingDown = false;

const shutdownSystem = async () => {
  if (isShuttingDown) return logger.info(`[SHUTDOWN] Shutdown already in progress, ignoring signal`);

  isShuttingDown = true;
  logger.info(`[SHUTDOWN] Initiating graceful shutdown`);

  try {
    // Clear the interval first
    if (cycleInterval) {
      clearInterval(cycleInterval);
      cycleInterval = null;
      logger.info(`[SHUTDOWN] Stopped cycle timer`);
    }

    // Wait for current cycle to complete
    while (isCycleRunning) {
      logger.info(`[SHUTDOWN] Waiting for current cycle to complete...`);
      await sleep(1000);
    }

    if (currentPosition) {
      logger.info(`[SHUTDOWN] Closing open position before shutdown`);
      await closePosition();
    }

    logger.info(`[SHUTDOWN] Unsubscribing from Drift client`);
    await driftClient.unsubscribe();

    logger.info(`[SHUTDOWN] Completed ${cycleCount} trading cycles`);
    logger.info(`[SHUTDOWN] System shutdown complete`);
  } catch (error) {
    logger.error(`[SHUTDOWN] Error during shutdown: ${(error as Error).message}`);
  }

  process.exit(0);
};

// Entry point
const main = async () => {
  try {
    await initializeSystem();

    // Signal handlers for graceful shutdown
    process.on("SIGINT", shutdownSystem);
    process.on("SIGTERM", shutdownSystem);

    logger.info(`[START] Beginning trading operations`);

    // Bootstrap cycle
    await executeTradingCycle();

    // Scheduled execution with proper cleanup
    cycleInterval = setInterval(executeTradingCycle, CYCLE_INTERVAL_MS);
  } catch (error) {
    logger.error(`[FATAL] System initialization failed: ${(error as Error).message}`);
    process.exit(1);
  }
};

main().catch(error => {
  logger.error(`[FATAL] Unhandled error: ${error.message}`);
  process.exit(1);
});
