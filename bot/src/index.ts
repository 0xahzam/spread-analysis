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
  FUNDING_RATE_PRECISION,
  PRICE_PRECISION,
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

// Slippage parameters
const MAX_SLIPPAGE_BPS = 25; // 25 basis points = 0.25%
const CLOSE_MAX_SLIPPAGE_BPS = 50; // Higher tolerance for exits

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

      const size = pos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber();

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

      const size = pos.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber();
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

// Funding cost tracking
const logFundingCosts = async () => {
  if (SIMULATION_MODE || !currentPosition) return;

  try {
    const driftMarket = marketMap.get("DRIFT");
    const kmnoMarket = marketMap.get("KMNO");

    if (!driftMarket || !kmnoMarket) return;

    const driftMarketAccount = driftClient.getPerpMarketAccount(driftMarket.marketIndex);
    const kmnoMarketAccount = driftClient.getPerpMarketAccount(kmnoMarket.marketIndex);

    if (!driftMarketAccount || !kmnoMarketAccount) return;

    const driftOracleData = driftClient.getOracleDataForPerpMarket(driftMarket.marketIndex);
    const kmnoOracleData = driftClient.getOracleDataForPerpMarket(kmnoMarket.marketIndex);

    if (!driftOracleData?.price || !kmnoOracleData?.price) return;

    // Get rates and prices
    const driftDailyRate = Number(driftMarketAccount.amm.last24HAvgFundingRate) / Number(FUNDING_RATE_PRECISION);
    const kmnoDailyRate = Number(kmnoMarketAccount.amm.last24HAvgFundingRate) / Number(FUNDING_RATE_PRECISION);
    const driftPrice = Number(driftOracleData.price) / Number(PRICE_PRECISION);
    const kmnoPrice = Number(kmnoOracleData.price) / Number(PRICE_PRECISION);

    if (!driftPrice || !kmnoPrice) return;

    // Calculate percentages and costs
    const driftPercent = (driftDailyRate / driftPrice) * 100;
    const kmnoPercent = (kmnoDailyRate / kmnoPrice) * 100;
    const netDailyCost = currentPosition.drift * driftDailyRate + currentPosition.kmno * kmnoDailyRate;

    logger.info(
      `[FUNDING] DRIFT: ${driftPercent.toFixed(5)}% KMNO: ${kmnoPercent.toFixed(5)}% Net: $${netDailyCost.toFixed(4)}/day`,
    );

    if (Math.abs(netDailyCost) > 10) {
      logger.warn(`[FUNDING] High net cost: $${netDailyCost.toFixed(2)}/day`);
    }
  } catch (error) {
    logger.warn(`[FUNDING] Error: ${(error as Error).message}`);
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

// Check liquidity depth and slippage
const checkLiquidity = async (marketSymbol: string, side: "bids" | "asks", orderSize: number) => {
  const checkStart = getHighResTime();

  try {
    const response = await fetch(`https://dlob.drift.trade/l2?marketName=${marketSymbol}`);
    if (!response.ok) throw new Error(`DLOB API error: ${response.status}`);

    const data = (await response.json()) as any;
    const orders = data[side];
    const oracle = data.oracle;

    const bestPrice = orders.length > 0 ? parseFloat(orders[0].price) / QUOTE_PRECISION.toNumber() : 0;

    logger.info(
      `[LIQUIDITY] ${marketSymbol} ${side.toUpperCase()} book depth: ${orders.length} levels, top=${bestPrice.toFixed(4)}, need=${orderSize}`,
    );

    let totalSize = 0;
    let totalValue = 0;

    for (const order of orders) {
      const levelPrice = parseFloat(order.price) / QUOTE_PRECISION.toNumber();
      const levelSize = parseFloat(order.size) / BASE_PRECISION.toNumber();

      const fillSize = Math.min(levelSize, orderSize - totalSize);
      totalValue += fillSize * levelPrice;
      totalSize += fillSize;

      logger.info(
        `[LIQUIDITY] ${marketSymbol} Level: price=${levelPrice.toFixed(4)} size=${levelSize.toFixed(1)} fillSize=${fillSize.toFixed(1)} cumulative=${totalSize.toFixed(1)}`,
      );

      if (totalSize >= orderSize) break;
    }

    const checkTime = Number(getHighResTime() - checkStart) / 1e6;

    if (totalSize < orderSize) {
      logger.warn(
        `[LIQUIDITY] ${marketSymbol} ${side.toUpperCase()} insufficient liquidity: need=${orderSize} available=${totalSize.toFixed(1)} check=${checkTime.toFixed(1)}ms`,
      );
      return { canFill: false, estimatedSlippage: Infinity };
    }

    const avgPrice = totalValue / totalSize;
    const oraclePrice = parseFloat(oracle) / QUOTE_PRECISION.toNumber();
    const slippage = Math.abs((avgPrice - oraclePrice) / oraclePrice);
    const bestSlippage = Math.abs((avgPrice - bestPrice) / bestPrice);

    logger.info(
      `[LIQUIDITY] ${marketSymbol} ${side.toUpperCase()} size=${orderSize} avgPrice=${avgPrice.toFixed(4)} bestPrice=${bestPrice.toFixed(4)} oracle=${oraclePrice.toFixed(4)} slippage=${(slippage * 100).toFixed(3)}% bestSlippage=${(bestSlippage * 100).toFixed(3)}% check=${checkTime.toFixed(1)}ms`,
    );

    return { canFill: true, estimatedSlippage: bestSlippage };
  } catch (error) {
    const checkTime = Number(getHighResTime() - checkStart) / 1e6;
    logger.error(
      `[LIQUIDITY] ${marketSymbol} ${side.toUpperCase()} check failed in ${checkTime.toFixed(1)}ms: ${(error as Error).message}`,
    );
    return { canFill: false, estimatedSlippage: Infinity };
  }
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

      // const oracleData = driftClient.getOracleDataForPerpMarket(marketConfig.marketIndex);
      // const oraclePrice = Number(oracleData.price) / Number(PRICE_PRECISION);
      // const slippageBps = reduceOnly ? CLOSE_MAX_SLIPPAGE_BPS : MAX_SLIPPAGE_BPS;
      // const maxSlippagePrice = oraclePrice * (slippageBps / 10000);
      // const oraclePriceOffset = new BN(maxSlippagePrice * Number(PRICE_PRECISION));

      // logger.info(
      //   `[ORDER] Oracle: ${oraclePrice.toFixed(4)} Slippage: ${slippageBps}bps (${maxSlippagePrice.toFixed(4)}) Offset: ${oraclePriceOffset.toString()}`,
      // );

      // const tx = await driftClient.placePerpOrder({
      //   orderType: OrderType.ORACLE,
      //   marketIndex: marketConfig.marketIndex,
      //   direction,
      //   baseAssetAmount: new BN(quantity).mul(BASE_PRECISION),
      //   oraclePriceOffset: oraclePriceOffset,
      //   reduceOnly,
      // });

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

// Position open
const openPosition = async (signal: Signal) => {
  if (signal === 0) return logger.debug(`[OPEN] Signal is 0, no position to open`);

  const driftDirection = signal > 0 ? PositionDirection.LONG : PositionDirection.SHORT;
  const kmnoDirection = signal > 0 ? PositionDirection.SHORT : PositionDirection.LONG;
  const signalStr = signal > 0 ? "LONG" : "SHORT";

  const driftSide = driftDirection === PositionDirection.LONG ? "asks" : "bids";
  const kmnoSide = kmnoDirection === PositionDirection.LONG ? "asks" : "bids";

  logger.info(
    `[OPEN] Opening ${signalStr} spread: DRIFT ${DRIFT_QUANTITY} ${driftDirection === PositionDirection.LONG ? "LONG" : "SHORT"} KMNO ${KMNO_QUANTITY} ${kmnoDirection === PositionDirection.LONG ? "LONG" : "SHORT"}`,
  );

  try {
    // Check liquidity for both legs in parallel
    const liquidityCheckStart = getHighResTime();
    const [driftLiquidity, kmnoLiquidity] = await Promise.all([
      checkLiquidity("DRIFT-PERP", driftSide, DRIFT_QUANTITY),
      checkLiquidity("KMNO-PERP", kmnoSide, KMNO_QUANTITY),
    ]);

    const liquidityCheckTime = Number(getHighResTime() - liquidityCheckStart) / 1e6;

    // Validate liquidity
    if (!driftLiquidity.canFill) {
      logger.warn(`Insufficient DRIFT liquidity for ${DRIFT_QUANTITY} ${driftSide}`);
    }
    if (!kmnoLiquidity.canFill) {
      logger.warn(`Insufficient KMNO liquidity for ${KMNO_QUANTITY} ${kmnoSide}`);
    }

    // Validate slippage
    const maxSlippageDecimal = MAX_SLIPPAGE_BPS / 10000;
    if (driftLiquidity.estimatedSlippage > maxSlippageDecimal) {
      throw new Error(
        `DRIFT slippage too high: ${(driftLiquidity.estimatedSlippage * 100).toFixed(3)}% > ${(maxSlippageDecimal * 100).toFixed(3)}%`,
      );
    }
    if (kmnoLiquidity.estimatedSlippage > maxSlippageDecimal) {
      throw new Error(
        `KMNO slippage too high: ${(kmnoLiquidity.estimatedSlippage * 100).toFixed(3)}% > ${(maxSlippageDecimal * 100).toFixed(3)}%`,
      );
    }

    logger.info(
      `[OPEN] Liquidity validated in ${liquidityCheckTime.toFixed(1)}ms - DRIFT: ${(driftLiquidity.estimatedSlippage * 100).toFixed(3)}% KMNO: ${(kmnoLiquidity.estimatedSlippage * 100).toFixed(3)}%`,
    );

    // Execute trades
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
    throw error;
  }
};

// Position close
const closePosition = async () => {
  if (!currentPosition) return logger.debug(`[CLOSE] No position to close`);

  logger.info(
    `[CLOSE] Closing position DRIFT=${currentPosition.drift} KMNO=${currentPosition.kmno} Signal=${currentPosition.signal}`,
  );

  try {
    const promises = [];

    // Check liquidity before closing positions
    if (currentPosition.drift !== 0) {
      // const driftSide = currentPosition.drift > 0 ? "bids" : "asks";
      // const driftLiquidity = await checkLiquidity("DRIFT-PERP", driftSide, Math.abs(currentPosition.drift));
      // const maxCloseSlippageDecimal = CLOSE_MAX_SLIPPAGE_BPS / 10000;
      // if (!driftLiquidity.canFill || driftLiquidity.estimatedSlippage > maxCloseSlippageDecimal) {
      //   logger.warn(`[CLOSE] DRIFT liquidity poor: ${(driftLiquidity.estimatedSlippage * 100).toFixed(3)}%`);
      // }

      promises.push(
        placeOrder(
          "DRIFT",
          currentPosition.drift > 0 ? PositionDirection.SHORT : PositionDirection.LONG,
          Math.abs(currentPosition.drift),
          true, // reduceOnly
        ),
      );
    }

    if (currentPosition.kmno !== 0) {
      // const kmnoSide = currentPosition.kmno > 0 ? "bids" : "asks";
      // const kmnoLiquidity = await checkLiquidity("KMNO-PERP", kmnoSide, Math.abs(currentPosition.kmno));
      // const maxCloseSlippageDecimal = CLOSE_MAX_SLIPPAGE_BPS / 10000;
      // if (!kmnoLiquidity.canFill || kmnoLiquidity.estimatedSlippage > maxCloseSlippageDecimal) {
      //   logger.warn(`[CLOSE] KMNO liquidity poor: ${(kmnoLiquidity.estimatedSlippage * 100).toFixed(3)}%`);
      // }

      promises.push(
        placeOrder(
          "KMNO",
          currentPosition.kmno > 0 ? PositionDirection.SHORT : PositionDirection.LONG,
          Math.abs(currentPosition.kmno),
          true, // reduceOnly
        ),
      );
    }

    await Promise.all(promises);
    currentPosition = null;
    logger.info(`[CLOSE] Successfully closed position`);
  } catch (error) {
    logger.error(`[CLOSE] Failed to close position: ${(error as Error).message}`);
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
    await logFundingCosts();

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
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 1000);

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
  const driftMarketAccount = driftClient.getPerpMarketAccount(driftMarket.marketIndex);
  const kmnoMarketAccount = driftClient.getPerpMarketAccount(kmnoMarket.marketIndex);

  if (!driftMarketAccount || !kmnoMarketAccount)
    throw new Error("Required markets DRIFT or KMNO Market Account not found");

  // Validate minimum order size
  const driftQuantityBase = DRIFT_QUANTITY * BASE_PRECISION.toNumber();
  const kmnoQuantityBase = KMNO_QUANTITY * BASE_PRECISION.toNumber();
  const driftMinOrder = driftMarketAccount.amm.minOrderSize.toNumber();
  const kmnoMinOrder = kmnoMarketAccount.amm.minOrderSize.toNumber();

  if (driftQuantityBase < driftMinOrder || kmnoQuantityBase < kmnoMinOrder) {
    throw new Error(
      `Order quantities too small. DRIFT min: ${driftMinOrder / BASE_PRECISION.toNumber()}, KMNO min: ${kmnoMinOrder / BASE_PRECISION.toNumber()}`,
    );
  }

  logger.info(`[INIT] Markets loaded: DRIFT(${driftMarket.marketIndex}) KMNO(${kmnoMarket.marketIndex})`);
  logger.info(
    `[INIT] Trading parameters: DRIFT_QTY=${DRIFT_QUANTITY} KMNO_QTY=${KMNO_QUANTITY} RATIO=${PRICE_RATIO} LAG=${SIGNAL_LAG_PERIODS}`,
  );

  // // Reconcile position state on startup
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
