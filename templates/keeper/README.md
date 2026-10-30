# Loktin keeper template

A keeper collects the scheduled deposits of Loktin Target Savings goals when they are due. This folder is a small Node program, built on `@loktin/sdk/keeper`, that runs one keeper pass and exits, plus a container image and examples for running it on a schedule. It works on Stellar testnet only for now.

## What the keeper can and cannot do

- Each pass finds the goals it serves, works out from each goal's stored data whether a deposit is due, and collects the due goals, one at a time per key. Each extra key is a channel (see "More channels").
- Anyone may collect a due goal. A collect can only move the deposit that is due from the goal owner's wallet into that owner's goal. The keeper cannot send funds anywhere else, change a goal's settings or withdraw.
- The keeper's key holds only XLM, to pay transaction fees. It has no role in the contracts and no power over anyone's funds.

## Copy this folder

Copy `templates/keeper/` into your own repository or onto your server, and keep its `package-lock.json`. The lockfile pins every package to an exact version, and `.npmrc` keeps it that way: no install scripts, exact versions only, and no package published less than 7 days ago. `npm ci` installs exactly what the lockfile lists.

```sh
npm ci
npm test
```

## Settings

The keeper reads environment variables only, and checks them all before any network call:

| Variable                        | Meaning                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `LOKTIN_KEEPER_SECRET_FILE`     | Path to a file holding the keeper's secret key, or several keys, one per line. Use this.                    |
| `LOKTIN_KEEPER_SECRET`          | The secret key itself, one key only. A weaker fallback: set only one of the two.                            |
| `LOKTIN_KEEPER_INTEGRATORS`     | Required. A comma list of integrator addresses whose goals the keeper serves, or `all` for every open goal. |
| `LOKTIN_KEEPER_OWNERS`          | Optional. A comma list of owner addresses whose open goals are added to the scan.                           |
| `LOKTIN_KEEPER_MAX_FEE_STROOPS` | Optional. The fee ceiling in stroops, 10,000,000 (1 XLM) by default.                                        |
| `LOKTIN_RPC_URL`                | Optional. The testnet RPC URL, `https://soroban-testnet.stellar.org` by default.                            |

A bad setting stops the keeper with one `keeper settings:` line per problem, and exit code 1. No message ever holds the secret.

## The key file

Create and fund a key for the keeper, then write its secret to a file. The secret goes straight from the Stellar CLI's keystore into the file and is never shown:

```sh
stellar keys generate loktin-keeper --network testnet --fund
sudo install -d -m 0700 /etc/loktin-keeper
stellar keys secret loktin-keeper | sudo sh -c 'cat > /etc/loktin-keeper/secret'
sudo chmod 0444 /etc/loktin-keeper/secret
```

The container runs as the `node` user, uid 1000, which is usually not the owner of the file on the host. So the file itself is readable by all, inside a folder only root can open. The container sees the file read-only at `/run/secrets/loktin_keeper_secret`.

## More channels

One account gets about one transaction into each ledger, because its transactions must go one sequence number at a time. A collect needs no signature but its sender's, so each extra key is simply another keeper account, with its own XLM for fees. Each key is a channel, and more channels collect more goals in the same time.

To add one, generate and fund another key, then append it to the key file. The file keeps its mode:

```sh
stellar keys generate loktin-keeper-2 --network testnet --fund
stellar keys secret loktin-keeper-2 | sudo sh -c 'cat >> /etc/loktin-keeper/secret'
```

The file then holds one key per line. Blank lines are ignored, and the same key twice is refused. In each pass, each key takes the next due goal when it is free and sends one transaction at a time. The pass checks that every key's account exists before it sends anything.

Measured with 2,000 goals on a private local network that closed one ledger a second:

| Channels | Goals collected | Sweep time | Collects per ledger | Failures |
| -------- | --------------- | ---------- | ------------------- | -------- |
| 1        | 2,000           | 3,003 s    | 0.67                | 0        |
| 2        | 2,000           | 1,528 s    | 1.31                | 0        |
| 4        | 2,000           | 786 s      | 2.55                | 0        |

On testnet, an estimate rather than a measurement: one channel collects at most about 720 goals an hour (one transaction per ledger, 720 ledgers an hour), and about 410 to 720 an hour is expected from the measured time of a write there. More channels multiply that while testnet's ledgers have room. The full results and how they were measured are in [docs/keeper-sizing.md](https://github.com/Lokt-In/loktin-sdk/blob/main/docs/keeper-sizing.md).

## Build the image

```sh
docker build -t loktin-keeper .
```

The image has two stages on `node:24.22.1-slim`, pinned by digest. The first installs the production packages from the lockfile; the second holds only them and `src/`, and runs as `node` with `NODE_ENV=production`. Build the image yourself, from your copy of this folder.

## Run one pass

```sh
docker run --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v /etc/loktin-keeper/secret:/run/secrets/loktin_keeper_secret:ro \
  -e LOKTIN_KEEPER_SECRET_FILE=/run/secrets/loktin_keeper_secret \
  -e LOKTIN_KEEPER_INTEGRATORS=<your integrator address> \
  loktin-keeper
```

The container needs no writable filesystem and no capabilities. It exits 0 when the pass ends, with or without skips, and 1 on an unexpected error or bad settings. The next pass tries again.

Without Docker, run `node src/run.ts` in this folder after `npm ci`, with the same settings. Node runs the TypeScript source directly from 22.18.0 and 23.6.0 on; Node 24 is what the image uses.

## Scheduling

One pass per run; your scheduler starts each run. `examples/` has three schedulers, each checked by the tests in `test/examples.test.ts`:

- `crontab`: one line that runs the container every hour, at 23 minutes past.
- `kubernetes-cronjob.yaml`: a CronJob that never runs two passes at once (`concurrencyPolicy: Forbid`). It mounts the key from a Kubernetes Secret as a file the `node` user can read, and runs as uid 1000, non-root, on a read-only filesystem, with no privilege escalation and all capabilities dropped. The image must be in a registry your cluster can pull from.
- `github-actions.yml`: a workflow that runs a pass four times an hour, for a repository holding a copy of this folder in `keeper/`. Only its keeper step sees the secret. That step writes the key to a file in a private temporary folder, runs the container with the file, and deletes the folder in every case.

GitHub's docs name the top of the hour as a high-load time for its scheduler, so the examples use other minutes.

## The fee ceiling

Before signing, the keeper reads each transaction's total fee. It refuses one above `LOKTIN_KEEPER_MAX_FEE_STROOPS` and logs the goal as skipped with the reason `FeeAboveCeiling`. The next pass tries that goal again. The default was set before the first collect on testnet. In the testnet smoke run, manual deposits cost 0.001 to 0.0105 XLM, and no write cost more than 0.27 XLM. The default of 1 XLM is well above those, and stops the keeper from paying for a rare fee spike.

## Log lines

Each pass writes JSON lines to standard output: one per goal, then a summary. They hold public keys, goal ids and transaction hashes, and never a secret. Amounts are in base units, as strings.

```json
{"goalId":"1","action":"collected","reason":null,"hash":"<transaction hash>","ledger":5557000,"amount":"10000000"}
{"goalId":"2","action":"skipped","reason":"Shortfall","hash":null,"ledger":null,"amount":null}
{"goalId":"3","action":"not-due","reason":null,"hash":null,"ledger":null,"amount":null}
{"summary":true,"keeper":"G...","channels":["G..."],"goalsFound":3,"collected":1,"skipped":1,"notDue":1,"failed":0,"events":9,"pages":14,"fromLedger":5436569,"toLedger":5557530}
```

- `collected`: the deposit was collected, with its transaction hash, ledger and amount.
- `skipped`: the contract refused for an expected reason (`NotDue`, `AlreadyCollected`, `DeadlinePassed`, `TargetReached`, `Shortfall`, `GoalNotFound` or `EnforcedPause`), or the fee was above the ceiling (`FeeAboveCeiling`).
- `not-due`: no deposit is due yet, so nothing was sent.
- `failed`: an unexpected error stopped the pass. The reason starts with the SDK's error code. When a transaction was sent, its hash is there to look up. `goalId` is null for a failure before any collect, such as a key whose account does not exist, and `channel` names the key it happened on, by its public key.

## Scheduled actions

The statement of work's "register and query scheduled actions" is, here, the keeper's watch settings (`LOKTIN_KEEPER_INTEGRATORS` and `LOKTIN_KEEPER_OWNERS`) and the goals each pass's scan finds. Nothing is registered on chain, because nothing needs to be: each goal's own stored data says when its next deposit is due.

## Coming later

Each pass scans the RPC's event window, about the last 7 days, and the goal lists of the given owners. The keeper's own store of goals and an `extend` step, which renews goals near expiry, come later. Every deposit, collect or withdraw already renews a goal's entries, so only a goal untouched for months needs `extend`.
