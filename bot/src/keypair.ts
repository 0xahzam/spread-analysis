import { Keypair } from '@solana/web3.js';
import logger from './utils';

const kp = Keypair.generate();
const arr = Array.from(kp.secretKey);
const buffer = Buffer.from(arr);
logger.info(`Public Key: ${kp.publicKey.toBase58()}`);
logger.info(`Private Key: ${buffer.toString('base64')}`);
logger.info(`Private Key Array: ${JSON.stringify(arr)}`);
