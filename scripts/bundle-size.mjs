// Measures the SDK's bundle size (T10): each of the four exports bundled as
// minified ESM with @stellar/stellar-sdk external, then gzipped.
//
// Usage: node scripts/bundle-size.mjs --check | --update
//
// Build the SDK first with `npm run build`. --update writes the sizes to
// packages/sdk/bundle-size.json. --check measures again and exits 1 if any
// size grew by more than 10% over that file.
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { rolldown } from 'rolldown';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = join(root, 'packages', 'sdk');
const recordPath = join(sdk, 'bundle-size.json');
const GROWTH_LIMIT = 0.1;

const ENTRIES = {
  '.': 'dist/index.js',
  './target-savings': 'dist/target-savings/index.js',
  './spend-save': 'dist/spend-save/index.js',
  './keeper': 'dist/keeper/index.js',
};

async function measure(entry) {
  const bundle = await rolldown({
    input: join(sdk, entry),
    // The peer dependency: the app's own copy is used.
    external: [/^@stellar\/stellar-sdk(\/.*)?$/],
    logLevel: 'silent',
  });
  const { output } = await bundle.generate({ format: 'esm', minify: true });
  await bundle.close();
  const code = output
    .filter((chunk) => chunk.type === 'chunk')
    .map((chunk) => chunk.code)
    .join('');
  return {
    minifiedBytes: Buffer.byteLength(code),
    gzipBytes: gzipSync(code, { level: 9 }).length,
  };
}

async function measureAll() {
  const exports = {};
  for (const [name, entry] of Object.entries(ENTRIES)) {
    exports[name] = await measure(entry);
  }
  return exports;
}

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--update') {
  console.error('usage: node scripts/bundle-size.mjs --check | --update');
  process.exit(1);
}

let measured;
try {
  measured = await measureAll();
} catch (error) {
  console.error(
    `could not bundle the SDK (run npm run build first): ${String(error)}`,
  );
  process.exit(1);
}

if (mode === '--update') {
  const record = {
    measuredWith:
      'rolldown, minified ESM, @stellar/stellar-sdk external, gzip level 9',
    exports: measured,
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${relative(root, recordPath)}`);
  for (const [name, size] of Object.entries(measured)) {
    console.log(
      `${name}: ${size.minifiedBytes} B minified, ${size.gzipBytes} B gzipped`,
    );
  }
} else {
  const recorded = JSON.parse(readFileSync(recordPath, 'utf8')).exports;
  let failed = false;
  for (const [name, size] of Object.entries(measured)) {
    const before = recorded[name];
    if (before === undefined) {
      console.error(`${name}: no recorded size; run npm run size:update`);
      failed = true;
      continue;
    }
    for (const key of ['minifiedBytes', 'gzipBytes']) {
      const growth = (size[key] - before[key]) / before[key];
      const line = `${name} ${key}: ${before[key]} -> ${size[key]} (${(growth * 100).toFixed(1)}%)`;
      if (growth > GROWTH_LIMIT) {
        console.error(`${line}, more than ${GROWTH_LIMIT * 100}% larger`);
        failed = true;
      } else {
        console.log(line);
      }
    }
  }
  if (failed) {
    console.error(
      'the bundle grew by more than 10%; if that is intended, run npm run size:update',
    );
    process.exit(1);
  }
}
