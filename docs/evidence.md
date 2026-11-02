# Evidence

This page collects the evidence for the Loktin SDK's `1.0.0` release, in the order of the three rows of the SOW's evidence table: the package, the keeper, and the docs with the reference app.

A few terms are used throughout:

- **Testnet** is Stellar's public test network. It works like the real network, but its money has no value. Everything on this page happened on testnet.
- A **transaction** is one action recorded on the network, such as a deposit. Each has a **hash**, a long code that identifies it. Every hash below is a link to that transaction on Stellar Expert, a public explorer, where anyone can check what it did, who sent it and when.
- A **ledger** is one block of transactions. Testnet closes one about every 5 seconds, and each has a number.
- An **integrator** is the app or team that adds Loktin to its own product. A **goal** is a Target Savings savings goal. A **skim** is the share of a spend that Spend & Save puts aside as savings.

## 1. The package

- npm: [`@loktin/sdk`](https://www.npmjs.com/package/@loktin/sdk)
- Source: [github.com/Lokt-In/loktin-sdk](https://github.com/Lokt-In/loktin-sdk)
- Install, with its one peer dependency:

  ```sh
  npm install @loktin/sdk @stellar/stellar-sdk
  ```

The source and the full test suite are in the repository, and CI runs them on every change: the contract tests, the SDK's unit tests on Node 22, 24 and 26, and the end-to-end tests on a private local Stellar network.

The transactions below were sent through the SDK by the repository's smoke script, which runs each user flow on testnet and records every hash in a file: [`evidence/testnet-smoke.json`](../evidence/testnet-smoke.json) for the run on 28 October 2026 (SDK 0.3.0), and [`evidence/testnet-smoke-window.json`](../evidence/testnet-smoke-window.json) for the withdrawal on 1 November 2026 (SDK 0.5.0). A Spend & Save withdrawal is only open on the user's chosen day of the month, which is why it came later.

### Spend & Save: configure a skim, run it against a spend, withdraw

| Step                                                                    | Date        | Transaction                                                                                                                      |
| ----------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| User A enrols with integrator A and sets the skim                       | 28 Oct 2026 | [`4e55b25a...54d8`](https://stellar.expert/explorer/testnet/tx/4e55b25aa46f26c45aca6809d1e8488c2e55663b6c93b87df3ce264fa06554d8) |
| User A pays user B, and the skim is saved in the same transaction       | 28 Oct 2026 | [`884bb41e...b810`](https://stellar.expert/explorer/testnet/tx/884bb41e24a15fb58c2edc768e9f7b12975b4d16fa0e28b9b478da6bfe54b810) |
| User A saves the skim on a spend made by other means                    | 28 Oct 2026 | [`c07fe74c...5e6d`](https://stellar.expert/explorer/testnet/tx/c07fe74c3554c31e48768c271061c9ed903685e15fe4ed9e65ad1599a5275e6d) |
| User A withdraws the integrator A balance, inside the withdrawal window | 1 Nov 2026  | [`5850362d...2f36`](https://stellar.expert/explorer/testnet/tx/5850362ddfe716f1eeb0bc41f0635444bc162e49f4c6a348fce50b552ed72f36) |

### Target Savings: create a goal, deposit into it, withdraw

| Step                                          | Date        | Transaction                                                                                                                      |
| --------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| User A creates a goal locked until its target | 28 Oct 2026 | [`8a6ae948...37a0`](https://stellar.expert/explorer/testnet/tx/8a6ae9482bc7f78983e33b88a8bc47c8ce858f9e7f0ca9e171ac2816b22637a0) |
| User A deposits half of the target            | 28 Oct 2026 | [`6a1a510a...1042`](https://stellar.expert/explorer/testnet/tx/6a1a510a79560d09be467f5f61b4aa0d18de4f20b395f669315987d444891042) |
| User A deposits the rest                      | 28 Oct 2026 | [`7d10e2f9...0a49`](https://stellar.expert/explorer/testnet/tx/7d10e2f92959a84d8f5ee193a4afb137e4d0cf194ef33d8166f9fdee2a5b0a49) |
| User A withdraws the goal at its target       | 28 Oct 2026 | [`40303bce...3b7b`](https://stellar.expert/explorer/testnet/tx/40303bced79bc654a5f8b00155a0cf218bec2669d964afea11b92827175d3b7b) |

The accounts, as recorded in the evidence files:

| Name         | Address                                                    |
| ------------ | ---------------------------------------------------------- |
| User A       | `GCHOME3M4KSLKMW2QPWCFRCCKJDQBF6VKWU5JOFZMJV2QA6WYOA2TCDQ` |
| User B       | `GBIEZ2GGV3AW2JYNMSOFLMDOXZBHVIOZP6QFZSVJWNGGWA3CAVS45ME4` |
| Integrator A | `GBMV4UX5WH7N5THS365Y5YL244FYK4W75S25VBOL2FQQSX2KAI4PQ4BX` |
| Integrator B | `GDLQBEVVOO35TFPREWQQYSKJJRODMNKNBDG7V52MPL4SBCSXLUJPEV7F` |

## 2. The keeper

A Target Savings goal can have scheduled deposits. They don't happen by themselves: someone has to send a `collect` transaction once each period is due. A **keeper** is the small program that does this. Loktin runs no keeper service for integrators: each integrator runs its own, from the [keeper template](../templates/keeper) in this repository.

The `Evidence keeper` workflow shows the template working on its own. Each run builds the template's image and runs one keeper pass in it, with nothing else: no Loktin server, no database. The pass talks only to the public testnet RPC (`https://soroban-testnet.stellar.org`), the network's own access point, so no Loktin-hosted service is in the path. The keeper's account is `GBGXVAB6ZS7EEZ7VYHSTZBDGGNKKCZJDER5PPI36PR2YY3Y22LPNDEAO`.

It serves two evidence goals, each with one deposit a day, due at 16:49 UTC. They were created by the smoke script, as recorded in [`evidence/evidence-goals.json`](../evidence/evidence-goals.json):

| Goal                   | Owner  | Integrator   |
| ---------------------- | ------ | ------------ |
| `17153673323361593451` | User A | Integrator A |
| `11555261307189156897` | User B | Integrator B |

These are the 8 scheduled deposits the keeper made, each a successful `collect`. The two in each run landed in consecutive ledgers, 5 seconds apart, and each pass took 9 to 12 seconds, finding the goals included.

| Run                                                                           | Started                         | Goal                   | Ledger  | Transaction                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------- | ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [40943764817](https://github.com/Lokt-In/loktin-sdk/actions/runs/40943764817) | 29 Oct 2026, 19:51 UTC, by hand | `17153673323361593451` | 5455969 | [`31c8d09a...126c`](https://stellar.expert/explorer/testnet/tx/31c8d09a82eb7220b40c254eb3db7ef371a3b100042253b82037c71d82ee126c) |
| [40943764817](https://github.com/Lokt-In/loktin-sdk/actions/runs/40943764817) | 29 Oct 2026, 19:51 UTC, by hand | `11555261307189156897` | 5455970 | [`ff3f84ac...c845`](https://stellar.expert/explorer/testnet/tx/ff3f84acb0c2d20f12d36d4e21f097b6d3ce14b4e61b239f6b14bd71ba45c845) |
| [41108799120](https://github.com/Lokt-In/loktin-sdk/actions/runs/41108799120) | 30 Oct 2026, 18:39 UTC          | `17153673323361593451` | 5472392 | [`18f14861...a3df`](https://stellar.expert/explorer/testnet/tx/18f14861f721f2dfc716ae2cc9944030b6eea113d5dce18b6e5d67ccbe11a3df) |
| [41108799120](https://github.com/Lokt-In/loktin-sdk/actions/runs/41108799120) | 30 Oct 2026, 18:39 UTC          | `11555261307189156897` | 5472393 | [`5aaa8397...b4e5`](https://stellar.expert/explorer/testnet/tx/5aaa839790be906f402a1a06238899134939beb2d22adf692b3b4c35ccf6b4e5) |
| [41225598293](https://github.com/Lokt-In/loktin-sdk/actions/runs/41225598293) | 31 Oct 2026, 17:39 UTC          | `17153673323361593451` | 5488952 | [`455592ec...18d6`](https://stellar.expert/explorer/testnet/tx/455592ec01e44e9434ef7eabb77d2e44a0581320fd6bfb1800bddcc0b60f18d6) |
| [41225598293](https://github.com/Lokt-In/loktin-sdk/actions/runs/41225598293) | 31 Oct 2026, 17:39 UTC          | `11555261307189156897` | 5488953 | [`29d4a49f...5092`](https://stellar.expert/explorer/testnet/tx/29d4a49fa3dc172c87a887ce10fce2820f96b7f889e702173fb465554f155092) |
| [41339369587](https://github.com/Lokt-In/loktin-sdk/actions/runs/41339369587) | 1 Nov 2026, 18:59 UTC           | `17153673323361593451` | 5507185 | [`97f811f2...559a`](https://stellar.expert/explorer/testnet/tx/97f811f2aad19e39fbea3f7f3e743bf97dfc01d0cac61f381b408aeef709559a) |
| [41339369587](https://github.com/Lokt-In/loktin-sdk/actions/runs/41339369587) | 1 Nov 2026, 18:59 UTC           | `11555261307189156897` | 5507186 | [`0d7030f6...f2b5`](https://stellar.expert/explorer/testnet/tx/0d7030f6c51ef3117b0be227d9a31de2dac5874bf91f54f423f21ef347b3f2b5) |

The first run was started by hand. The other three were started by the workflow's schedule.

The schedule asks for four runs an hour, but GitHub does not keep to it. Between 29 October and 1 November, GitHub ran the workflow 17 to 19 times a day, not 96. The median gap between runs was 28 minutes, and the largest about 6 hours. So the deposits, due at 16:49 UTC, landed 1 to 3 hours late. A goal's deposit can be collected at any time in its period, so with one deposit a day the collects still happened, only late. GitHub's own [documentation of the schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) says scheduled runs can be delayed at busy times, and some dropped.

GitHub deletes a run's log after 90 days, which is why the hashes are copied onto this page. Each transaction stays on the network and can still be checked through its link.

## 3. The docs and the reference app

- The SDK docs: [docs.loktin.xyz/sdk](https://docs.loktin.xyz/sdk/)
- The reference integration, an app built on the SDK: [github.com/Lokt-In/loktin-sdk-example](https://github.com/Lokt-In/loktin-sdk-example)
- The live reference app: [demo.loktin.xyz](https://demo.loktin.xyz)
- The browser test, run by hand through the reference app on 1 November 2026 in Chrome with the Freighter wallet extension: [`docs/smoke-test.md`](https://github.com/Lokt-In/loktin-sdk-example/blob/main/docs/smoke-test.md) in the reference integration's repository. Every hash in it has been checked on testnet.
- The walkthrough: the link is added here when it's published.
