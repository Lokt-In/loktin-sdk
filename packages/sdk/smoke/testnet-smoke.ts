// The testnet smoke script (V6). The owner runs it with their own keys, in
// the Stellar CLI keystore:
//
//   node packages/sdk/smoke/testnet-smoke.ts <goals|run|window>
//
// after `npm run build`. The runbook is the "Testnet smoke run" section of
// docs/deploy.md. Aliases default to loktin-smoke-user-a, -user-b,
// -integrator-a and -integrator-b; set LOKTIN_SMOKE_USER_A, _USER_B,
// _INTEGRATOR_A or _INTEGRATOR_B to use others.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTNET } from '@loktin/sdk';
import { PHASES, type Phase, ROLES, type Role, isPhase } from './helpers.ts';
import { runPhase } from './phases.ts';
import { cliSigner, publicKeyOf } from './signer.ts';

const USAGE = `usage: node packages/sdk/smoke/testnet-smoke.ts <${PHASES.join('|')}>`;

const EVIDENCE_FILES: Readonly<Record<Phase, string>> = {
  goals: 'evidence-goals.json',
  run: 'testnet-smoke.json',
  window: 'testnet-smoke-window.json',
};

const DEFAULT_ALIASES: Readonly<Record<Role, string>> = {
  userA: 'loktin-smoke-user-a',
  userB: 'loktin-smoke-user-b',
  integratorA: 'loktin-smoke-integrator-a',
  integratorB: 'loktin-smoke-integrator-b',
};

const ALIAS_VARIABLES: Readonly<Record<Role, string>> = {
  userA: 'LOKTIN_SMOKE_USER_A',
  userB: 'LOKTIN_SMOKE_USER_B',
  integratorA: 'LOKTIN_SMOKE_INTEGRATOR_A',
  integratorB: 'LOKTIN_SMOKE_INTEGRATOR_B',
};

const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SDK_DIR, '..', '..');

function gitCommit(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', ROOT, 'rev-parse', 'HEAD'], (error, stdout) => {
      if (error === null) {
        resolve(stdout.trim());
      } else {
        reject(new Error('could not read the git commit'));
      }
    });
  });
}

async function main(phase: Phase): Promise<boolean> {
  const aliases = {} as Record<Role, string>;
  const addresses = {} as Record<Role, string>;
  for (const role of ROLES) {
    const alias = process.env[ALIAS_VARIABLES[role]] ?? DEFAULT_ALIASES[role];
    aliases[role] = alias;
    addresses[role] = await publicKeyOf(alias);
  }
  const signers = new Map(
    ROLES.map((role) => [
      aliases[role],
      cliSigner(aliases[role], addresses[role], TESTNET.passphrase),
    ]),
  );
  const manifest = JSON.parse(
    await readFile(join(SDK_DIR, 'package.json'), 'utf8'),
  ) as { version: string };
  return runPhase(phase, {
    network: TESTNET,
    signerFor: (alias) => {
      const signer = signers.get(alias);
      if (signer === undefined) throw new Error(`no signer for ${alias}`);
      return signer;
    },
    aliases,
    addresses,
    evidencePath: join(ROOT, 'evidence', EVIDENCE_FILES[phase]),
    clock: {
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    sdkVersion: manifest.version,
    commit: await gitCommit(),
    log: (line) => {
      console.log(line);
    },
  });
}

const phase = process.argv[2];
if (process.argv.length !== 3 || !isPhase(phase)) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  main(phase).then(
    (completed) => {
      process.exitCode = completed ? 0 : 1;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
