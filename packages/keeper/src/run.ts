// One keeper pass (E5): scan, collect what is due, log, exit. Run with
//
//   node packages/keeper/src/run.ts
//
// after `npm run build`. Settings come from environment variables (see
// settings.ts). Exits 0 when the pass ends, with or without skips, and 1 on
// a failure or bad settings (E7). Logs are one JSON line per goal, then a
// summary line, with public keys and hashes only (E8).
import { Keypair } from '@stellar/stellar-sdk/base';
import { basicNodeSigner } from '@stellar/stellar-sdk/contract';
import { readFile } from 'node:fs/promises';
import { TESTNET, createLoktin } from '@loktin/sdk';
import { feeCeilingSigner, runPass } from '@loktin/sdk/keeper';
import { reportLines, toLine } from './report.ts';
import { SettingsError, loadSettings } from './settings.ts';

async function main(): Promise<number> {
  let settings;
  try {
    settings = await loadSettings(process.env, (path) =>
      readFile(path, 'utf8'),
    );
  } catch (error) {
    if (error instanceof SettingsError) {
      for (const problem of error.problems) {
        console.error(`keeper settings: ${problem}`);
      }
      return 1;
    }
    throw error;
  }
  const keypair = Keypair.fromSecret(settings.secret);
  const keeper = keypair.publicKey();
  // Testnet only for now. createLoktin checks the RPC URL before any call.
  let loktin;
  try {
    loktin = createLoktin({
      network: TESTNET,
      rpcUrl: settings.rpcUrl,
      publicKey: keeper,
      signer: {
        signTransaction: feeCeilingSigner(
          basicNodeSigner(keypair, TESTNET.passphrase).signTransaction,
          settings.maxFeeStroops,
          TESTNET.passphrase,
        ),
      },
    });
  } catch (error) {
    console.error(
      `keeper settings: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const pass = await runPass(loktin, {
    integrators: settings.integrators,
    owners: settings.owners,
  });
  for (const record of reportLines(pass, keeper)) {
    console.log(toLine(record));
  }
  return pass.failure === undefined ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(
      toLine({
        action: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  },
);
