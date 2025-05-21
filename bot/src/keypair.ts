import { Keypair } from "@solana/web3.js";
import logger from "./utils";

const kp = Keypair.generate();
logger.info(`Public Key: ${kp.publicKey.toBase58()}`);
logger.info(`Secret Key Array: ${JSON.stringify(Array.from(kp.secretKey))}`);
