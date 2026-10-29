# Keeper sizing

How many goals one keeper pass collects, with 1, 2 and 4 channel accounts (E3, W114). The full results are in [`keeper-sizing.json`](keeper-sizing.json).

## How it was measured

`npm run sizing:keeper` starts the same private local network as the end-to-end tests (stellar/quickstart with testnet limits, protocol 29) and refuses any other network. It sets up 100 owners with 20 goals each, 2,000 goals in all, with a 60-second cadence and a 1 TEST deposit, and enough balance and allowance for every collect. Once the goals are due, it runs three sweeps over the same goals, each in a later period: one pass with 1 channel, then 2, then 4. Each sweep is one `runPass` call, scan included. Sends answered TRY_AGAIN_LATER are counted by the RPC connection the script passes in, because the SDK resends them itself and does not report them.

The run on 29 October 2026 took 5,716 seconds (about 95 minutes), 126 of them for the goals, on an 11th Gen Intel Core i7-1185G7 (8 threads, 15 GiB) under WSL2 with Node 24.22.1. The local network closed one ledger a second.

To rerun it quickly with fewer goals, run `npm run sizing:keeper -- --goals 200`. A smaller run prints its table and leaves the JSON file alone.

## Measured on the local network

| Channels | Goals collected | Sweep time | Ledgers spanned | Collects per ledger | Most in one ledger | TRY_AGAIN_LATER | Failures |
| -------- | --------------- | ---------- | --------------- | ------------------- | ------------------ | --------------- | -------- |
| 1        | 2,000           | 3,003 s    | 3,002           | 0.67                | 1                  | 0               | 0        |
| 2        | 2,000           | 1,528 s    | 1,526           | 1.31                | 2                  | 0               | 0        |
| 4        | 2,000           | 786 s      | 783             | 2.55                | 4                  | 0               | 0        |

Each channel sends one transaction at a time and waits for it to land, so one channel collects about two goals every three ledgers. The channels shared the goals evenly (1,001 and 999 with two channels; 494 to 503 with four), and the rate grew with each channel added.

## On testnet: an estimate

This is an estimate, not a measurement. The sizing script never runs on testnet.

- **The ceiling.** One account gets about one transaction into each ledger, because its transactions must go one sequence number at a time. Testnet targets one ledger every 5 seconds, 720 ledgers an hour, so one channel collects at most about 720 goals an hour.
- **The local rate does not carry over.** On the local network a collect's round trip, from simulation to confirmation, takes about 1.5 one-second ledgers, which is why one channel collected 0.67 goals per ledger. On testnet's 5-second ledgers the round trip takes a different share of a ledger, so the rate per ledger above cannot simply be converted.
- **From the testnet smoke run.** Its 50 writes took 4,834 ms at the median and 8,787 ms at the 95th percentile (`evidence/testnet-smoke.json`). One channel sending one collect at a time would then manage about 3,600 / 8.8 = 410 to 3,600 / 4.8 = 745 collects an hour, so about 410 to 720 once the ceiling applies.
- **More channels.** Each channel adds about as much again, while testnet's ledgers have room for the extra transactions.

The evidence keeper's real collect times on testnet will be added here later.
