// One keeper pass (E5): scan, collect what is due, log, exit. Run with
//
//   node src/run.ts
//
// in this folder, after `npm ci`, or in the image (see the README). Settings
// come from environment variables (see settings.ts). Exits 0 when the pass
// ends, with or without skips, and 1 on a failure or bad settings (E7). Logs
// are one JSON line per goal, then a summary line, with public keys and
// hashes only (E8).
import { readFile } from 'node:fs/promises';
import { runPass } from '@loktin/sdk/keeper';
import { keepersOf } from './keepers.ts';
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
  // One instance per key, each a channel. createLoktin checks the RPC URL
  // before any call.
  let keepers;
  try {
    keepers = keepersOf(settings);
  } catch (error) {
    console.error(
      `keeper settings: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  const [first] = keepers;
  if (first === undefined) {
    // loadSettings never returns without a key.
    throw new Error('no keeper key');
  }
  // One key passes the single instance, so it runs exactly as on 0.4.0.
  const pass = await runPass(keepers.length === 1 ? first : keepers, {
    integrators: settings.integrators,
    owners: settings.owners,
  });
  const channels = keepers.map((keeper) => keeper.config.publicKey ?? '');
  for (const record of reportLines(pass, channels)) {
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
