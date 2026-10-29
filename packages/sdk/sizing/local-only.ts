// The sizing run's first global setup: it refuses to go on unless the RPC
// serves the private local network, so nothing is ever sent to testnet.
import { PASSPHRASE } from '../e2e/local-network.js';

export default async function localOnly(): Promise<void> {
  const port = process.env['E2E_PORT'] ?? '8000';
  const response = await fetch(`http://localhost:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
  });
  const body = (await response.json()) as {
    result?: { passphrase?: string };
  };
  if (body.result?.passphrase !== PASSPHRASE) {
    throw new Error(
      `keeper sizing runs on the local network only, not on "${String(body.result?.passphrase)}"`,
    );
  }
}
