import { Connection } from '@solana/web3.js';
import logger from './utils';

// Load RPC endpoints
const RPC_HTTP = Bun.env.RPC_ENDPOINT;
const RPC_WS = Bun.env.RPC_WS;

const PUBLIC_KEY = Bun.env.PUBLIC_KEY;
const PRIVATE_KEY = Bun.env.PRIVATE_KEY;

if (!RPC_HTTP || !RPC_WS) {
  logger.error('Missing RPC_ENDPOINT or RPC_WS in environment');
  throw new Error('Missing RPC_ENDPOINT or RPC_WS in environment');
}

if (!PRIVATE_KEY) {
  logger.error('Missing PRIVATE_KEY in environment');
  throw new Error('Missing PRIVATE_KEY in environment');
}

// Export config
export const config = {
  RPC_HTTP,
  RPC_WS,
  PUBLIC_KEY,
  PRIVATE_KEY,
};

// Connections
export const connection = new Connection(RPC_HTTP, {
  wsEndpoint: RPC_WS,
  commitment: 'processed',
});
