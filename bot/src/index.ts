import {
  DriftClient,
  Wallet,
  initialize,
  BulkAccountLoader,
  PerpMarkets,
  OracleSource,
  PythLazerClient,
} from "@drift-labs/sdk";
import { Keypair, PublicKey } from "@solana/web3.js";
import { connection } from "./config";
import logger from "./utils";

const sdk = initialize({ env: "mainnet-beta" });
const programId = new PublicKey(sdk.DRIFT_PROGRAM_ID);
const wallet = new Wallet(Keypair.generate());
const loader = new BulkAccountLoader(connection, "processed", 1000);

const driftClient = new DriftClient({
  connection,
  wallet,
  programID: programId,
  accountSubscription: {
    type: "polling",
    accountLoader: loader,
  },
});

await driftClient.subscribe();
logger.info("Drift client subscribed");

const pyth = new PythLazerClient(connection);
const marketMap = Object.fromEntries(
  PerpMarkets["mainnet-beta"].map((m) => [m.baseAssetSymbol, m])
);

async function getPrice(symbol: string): Promise<number> {
  const market = marketMap[symbol.toUpperCase()];
  if (!market) throw new Error(`Market not found: ${symbol}`);

  try {
    switch (market.oracleSource) {
      case OracleSource.PYTH_LAZER: {
        const data = await pyth.getOraclePriceData(market.oracle);
        if (!data?.price) throw new Error("PYTH_LAZER returned invalid data");
        const px = data.price.toNumber() / 1e6;
        logger.debug(`PYTH_LAZER ${symbol}: ${px}`);
        return px;
      }

      case OracleSource.PYTH_PULL: {
        const data = driftClient.getOraclePriceDataAndSlot(
          market.oracle,
          market.oracleSource
        );
        if (!data || !data.data?.price)
          throw new Error("PYTH_PULL returned invalid data");
        const px = data.data.price.toNumber() / 1e6;
        logger.debug(`PYTH_PULL ${symbol}: ${px}`);
        return px;
      }

      default:
        throw new Error(`Unsupported oracle type: ${market.oracleSource}`);
    }
  } catch (e) {
    logger.error(`Error fetching price for ${symbol}: ${(e as Error).message}`);
    throw e;
  }
}

const FREQUENCY = 15 * 60 * 1000;

setInterval(async () => {
  const drift = await getPrice("DRIFT");
  const kmno = await getPrice("KMNO");

  const spread = drift - 10 * kmno;
  const signal = spread < 0 ? 1 : spread === 0 ? 0 : -1;

  logger.info(
    `[SPREAD] drift=${drift} kmno=${kmno} spread=${spread} signal=${signal}`
  );
}, FREQUENCY);
