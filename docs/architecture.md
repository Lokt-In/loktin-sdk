# Loktin SDK: Architecture

Status: planning complete (2026-10-22). Only agreed decisions are written here. Any change is a new, recorded decision.
Sprint: 30 days, ending 2026-11-05.

## 0. Scope and agreed constraints

What we are building, from the Statement of Work:

- A headless TypeScript package that lets any Stellar wallet or remittance team add two savings primitives to their own product, with their own interface and their own signing flow:
  - **Spend & Save**: skims a share of each spend in the host app into savings that the user can reach once a month.
  - **Target Savings**: saving toward a goal with scheduled or manual deposits.
- Integrator-owned keeper tooling: a keeper client in the SDK and a deployable keeper template (container, scheduling, secrets) that an integrating team runs on its own infrastructure.
- Reference documentation and a quickstart on docs.loktin.xyz, a reference integration, and a published walkthrough.

Agreed constraints:

1. **One repo.** Everything lives in a new repo, `loktin-sdk`, in the Lokt-In GitHub organisation. The contracts are written from scratch in this repo. The older `loktin` repo is not changed.
2. **The SDK is the core.** Any frontend, Loktin's own included, sits outside this repo and talks to the contracts only through the SDK. An integrator calls the SDK directly.
3. **Languages.** The SDK and the keeper tooling are TypeScript. Contracts are Rust, the only language Stellar smart contracts support.
4. **No promised yield.** The SDK ships no yield code and no yield functions. The contracts have a slot for a yield source that is empty and switched off by default. An integrator may program their own yield source into it. Nothing anywhere states or implies a return.
5. **Networks.** Deploy to testnet only during this sprint. Build to mainnet standard: key handling, roles, upgrades and tests are designed as if for mainnet.
6. **New contract addresses.** The new contracts are new deployments. Nothing migrates from the old contracts.
7. **Fees.** Any early-withdrawal penalty goes to an address the integrator sets. Loktin takes no fee in this sprint. A revenue model for Loktin is planned separately and must be possible within the contract design.
8. **Runtimes.** Browser and Node.
9. **Publishing.** The repo stays private and nothing is published to npm until the owner says so. The planned moment is when the core client and signer injection work against testnet: the repo goes public first, then a preview version is published, on the owner's go-ahead.
10. **First integrator.** Loktin's own reference app.

### 0.1 SOW coverage

Every check ticks this table. "Planned" means a section of this document covers it; "Built" means merged code does; "Evidenced" means the SOW evidence exists.

| SOW item | Covered by | Status |
|---|---|---|
| Public TypeScript package, integrator's own UI and own signing flow | Sections 0, 7 | Planned |
| Spend & Save: skim configuration, skim execution against a spend, balance reads, withdrawal | Section 4 (P11 to P16) | Planned |
| Spend & Save typed config: skim percentage, round-up, per-period caps, destination | Section 4 (P12, P13, P15) | Planned |
| Spend & Save accessible once a month | Section 4 (P16) | Planned |
| Target Savings: goal creation, scheduled and manual deposits, balance and progress reads, withdrawal | Section 4 (P1 to P10) | Planned |
| Target Savings typed config: target amount, deadline, cadence, deposit size, early-withdrawal rules | Section 4 (P1, P4) | Planned |
| Keeper client module: register and query scheduled actions | Sections 6, 8 (E1) | Planned |
| Deployable keeper template: container, cron scheduling, secret management, runs on integrator infrastructure | Sections 2, 8 (E4 to E9) | Planned |
| Reads go directly to the chain; no Loktin server in the path; read adapter with an on-chain default | G8, G10, section 7 (K9) | Planned |
| Test suite covering every exposed method, CI | G9, section 9 | Scaffold built |
| npm build and release pipeline, preview tag, then first stable version | G5, section 10 (V1 to V3) | Planned |
| Docs and quickstart on docs.loktin.xyz, reference integration repo, published walkthrough | Section 10 (V9 to V11) | Planned |
| Evidence: npm link, GitHub repo, testnet transaction hashes, keeper evidence document | Section 10 (V6, V7, V12) | Planned |
| Out of scope respected: mainnet, Locked In, Bill Plans, composable savings types, UI components, Loktin-hosted API or indexer | Section 0, G8 | Planned |

## 1. Ground rules

Agreed 2026-10-22. Every later decision is checked against these rules. A change to a rule is a new decision.

- **G1 Security process.** Follow NIST SP 800-218, the Secure Software Development Framework v1.1, across its four practice groups: prepare the organisation, protect the software, produce well-secured software, respond to vulnerabilities. In practice:
  - every design area has a threat model built on Stellar's STRIDE template (developers.stellar.org, Security Best Practices, Threat Modeling);
  - the repo and releases are protected and verifiable;
  - a SECURITY.md explains how to report a vulnerability.
- **G2 Contract security.** Every privileged function is listed with exactly who can call it. Access control, pausing and upgrades use the audited OpenZeppelin Stellar contracts library rather than hand-written code; the version is chosen in section 6. Release builds keep overflow checks on. The Stellar vulnerability classes (authorization, reinitialization, arithmetic, storage TTL and archival, cross-contract calls, resource exhaustion) are checked for every contract.
- **G3 No one but the user moves the user's money.** No role, including the Loktin admin, can move a user's funds anywhere except back to that user, or to a destination a rule the user agreed to names (for example an early-withdrawal penalty address). This is an invariant that the tests must prove.
- **G4 Time tolerance.** Contracts tell time only from the ledger close time. Stellar's docs state that it can lag a few seconds behind or run up to 60 seconds ahead, and is strictly increasing. Every time-based rule defines its behaviour at its boundaries with that in mind.
- **G5 Supply chain.**
  - Lockfiles are committed. Dependency versions are pinned, and dependencies are kept to a minimum.
  - Releases are published from GitHub Actions using npm trusted publishing (OIDC), so no long-lived publish token exists.
  - The repo is made public before the first npm publish, because npm does not generate provenance for packages published from a private repository.
  - The OpenSSF Scorecard checks are the measure: pinned dependencies, token permissions, branch protection, dangerous workflows, security policy and signed releases.
- **G6 Versioning.** The npm package follows Semantic Versioning 2.0.0. Each contract records its version in its contract metadata. Commit messages follow Conventional Commits 1.0.0. A changelog is kept.
- **G7 Runtimes.** The minimum is Node 22.12, the minimum that `@stellar/stellar-sdk` 17.2.1 and 17.3.0 themselves require. CI tests Node 22, 24 and 26. Browser targets are set in section 7.
- **G8 Performance.**
  - No Loktin server sits in any request path.
  - A read costs one RPC call. A write costs one account lookup for the sequence number, then simulate, sign, send and confirm, and nothing more.
  - Independent reads run in parallel.
  - The integrator always chooses the RPC endpoint.
  - Numeric budgets (latency per call, package size) are set in section 9 from testnet measurements.
- **G9 Maintainability.**
  - One shared core with one module per primitive.
  - Errors carry stable, documented codes. Every public function is documented.
  - Design decisions are recorded as short decision notes in `docs/decisions/`.
  - CI enforces strict type checking, linting and formatting. Every exposed method has tests.
- **G10 Privacy and configuration.** The SDK sends nothing to Loktin: no telemetry, no stored user data. The keeper takes all configuration from environment variables.
- **Repo rules.** These apply to all code, docs, commits and pull requests:
  - no tool or vendor attribution anywhere: no co-author trailers, no tool credit lines, no mention of the tools used to write the code;
  - only the owner commits and pushes;
  - no keys or secrets anywhere, and scripts refer to keys by alias only;
  - the owner creates every key and runs every deploy. Throwaway keys and contracts created inside CI's private local network (section 9, T8) are tests, not deploys: nothing reaches testnet and no key outlives the run;
  - local tool settings stay in `.git/info/exclude`, never in `.gitignore`.

## 2. Repo, tooling and supply chain

Agreed 2026-10-22.

### 2.1 Layout

```
loktin-sdk/
├─ contracts/            Rust, one crate per contract (target-savings, spend-save),
│                        plus common/: a shared library crate, never deployed
├─ packages/
│  └─ sdk/               the TypeScript package, @loktin/sdk
├─ keeper-template/      deployable keeper (TypeScript and Docker), built on packages/sdk
├─ scripts/              build and deploy scripts; keys referred to by alias only
├─ docs/
│  ├─ architecture.md    this document
│  └─ decisions/         short decision notes
├─ .github/              workflows, dependabot.yml
├─ Cargo.toml, Cargo.lock, rust-toolchain.toml
├─ package.json, package-lock.json, .npmrc, .nvmrc
└─ LICENSE, README.md, SECURITY.md, CHANGELOG.md
```

- Whether the SDK is one package or several is decided in section 7.
- The reference integration lives in its own repo (section 10).
- The keeper template is a folder in this repo. Section 10 decides whether to also publish it as a standalone template repo.

### 2.2 Toolchain

| Area | Rule |
|---|---|
| Rust | Pinned in `rust-toolchain.toml` to 1.99.1 with the `wasm32v1-none` target. The soroban-sdk version is chosen in section 6. `Cargo.lock` is committed and every cargo command in CI uses `--locked`. Cargo has no release-age setting, so every crate is pinned exactly (`=x.y.z`), must be at least 7 days old, and the publish dates of all locked crates are checked at every review. |
| Stellar CLI | Pinned to 28.1.0 for builds and deploys. |
| Node | Development and releases use Node 24, because its bundled npm supports `min-release-age` (added in npm 11.10.0; Node 22 bundles npm 10.9). `.nvmrc` holds 24. CI runs the test suite on Node 22, 24 and 26. Published `engines.node` is `>=22.12.0`. |
| Package manager | npm workspaces. `package-lock.json` is committed and CI installs with `npm ci`. |
| `.npmrc` | `ignore-scripts=true`, `save-exact=true`, `min-release-age=7`. A package that needs an urgent fix may be listed in `min-release-age-exclude`, and that exemption is a recorded decision. A dependency that cannot work without an install script is a decision for the owner, never a silent change. |
| TypeScript | 6.0.x, strict mode. Not 7.x until typescript-eslint supports it (8.72.0 supports typescript below 6.1.0). |
| Lint and format | ESLint 10 with typescript-eslint 8 (type-aware rules), and Prettier 3. |
| Tests | Vitest 5. Details in section 9. |
| Module format | ESM only, with an `exports` map. Node 22.12 and later load ESM through `require()` by default, so CommonJS consumers on supported Node versions still work. |
| Licence | Apache-2.0. |

### 2.3 GitHub and CI

- Changes reach `main` only through pull requests with CI passing. A ruleset on `main` blocks force-pushes and deletion. The Lokt-In org is on the GitHub Team plan, so rulesets apply while the repo is private.
- The Lokt-In org requires two-factor authentication for all members.
- Every third-party GitHub Action is pinned to a full-length commit SHA, with the version in a trailing comment. Workflows default to `permissions: contents: read`. Only the release job is granted `id-token: write`.
- Dependabot watches npm, Cargo, GitHub Actions and Docker, with a 7-day cooldown. It ignores TypeScript major 7 until typescript-eslint supports it.
- Secret scanning: gitleaks runs in CI from day one. GitHub secret scanning and push protection are switched on when the repo goes public, since on private repos they need the paid Secret Protection add-on.
- No git hooks. CI enforces the checks.
- Local tool settings for anyone working in the repo go in `.git/info/exclude`.

## 3. Lessons from the old contracts

Agreed 2026-10-22. These come from a review of the earlier Target Savings and Spend & Save contracts, their yield helper and their keeper, in the separate `loktin` repo. Each one is a requirement for this repo. The section named in brackets is where it gets resolved.

Requirements:

- **L1 No discretionary movement of funds.** No role may send user funds anywhere except back to that user, or to a destination named by a rule the user agreed to. Any yield source is opt-in and the contract bounds what can move to it. (Section 6.)
- **L2 Separate roles.** Admin, keeper, fee or penalty recipient and any upgrade or pause authority are separate roles, each with the least power that works. (Section 6.)
- **L3 Integrator-run automation.** Scheduled deposits must be executable without any Loktin-held key or Loktin-run service. (Sections 6 and 8.)
- **L4 Deposits stop at the goal.** Scheduled deposits must stop when a goal reaches its target and when it passes its end date. Tests prove both. (Section 4.)
- **L5 No partial closes.** A position is never marked closed or zeroed unless the full amount owed was paid out. A shortfall reverts the transaction.
- **L6 No promised rate.** No contract, SDK function, doc or event states or implies a rate of return. Yield exists only through the opt-in slot, off by default. (Section 6.)
- **L7 Defined catch-up behaviour.** What happens after missed scheduled periods (catch up or skip and record) is an explicit rule. (Section 4.)
- **L8 Defined time windows.** Every time window, including the once-a-month access in Spend & Save, has defined boundaries that allow for the ledger close time running up to 60 seconds ahead. (Section 4.)
- **L9 The host's payment flow is respected.** How a skim relates to the host's own payment is an explicit design choice. (Section 4.)
- **L10 Storage renewal plan.** Every kind of stored data (instance, persistent, temporary) has a written TTL renewal plan. Stellar docs: instance storage shares the contract instance's TTL; archived persistent and instance entries can be restored automatically since protocol 23 when simulation adds them to the restore list, with normal rent and fees. (Section 6.)
- **L11 Bounded storage.** No per-user list grows without limit. User-supplied strings have length limits. Discovery uses events or paging. (Section 6.)
- **L12 No panics for expected failures.** Every expected failure returns a stable, documented error code. No `unwrap()` on stored configuration. No unused error codes.
- **L13 Truthful events.** An event is emitted only for something that happened. Events are a documented public interface.
- **L14 Upgrade and pause.** Contracts have an upgrade path and a pause control built on the audited OpenZeppelin library, with defined limits on who may use them. (Section 6.)
- **L15 Keeper safety.**
  - The keeper key has no power over funds.
  - The keeper exits on an unexpected error and restarts cleanly, rather than carrying on. Node's docs say it is not safe to resume normal operation after an uncaught exception.
  - Goal discovery and transaction throughput are designed, not improvised. (Section 8.)
- **L16 Negative and property tests.** Tests prove who cannot call each function, not only that the right caller can. Property-based tests cover the money rules. (Section 9.)

Kept from the old design:

- typed errors;
- one event per state change;
- users authorize their own actions;
- an on-chain due-date check, so a repeated keeper call cannot pay twice;
- fees paid out in the same transaction rather than held in the contract;
- capped, expiring, revocable token allowances for automatic deposits;
- a missed deposit, recorded when the balance or allowance is short, instead of a failed transaction.

## 4. Product rules

Agreed 2026-10-22. The contracts enforce every rule in this section. The SDK only helps apply them.

### 4.1 Facts these rules rest on

- **One operation per contract transaction.** A smart contract transaction carries only one operation (Stellar docs, Operations and Transactions). A classic payment and a contract call therefore cannot share one transaction. Paying and saving can only succeed or fail together if both happen inside one contract call.
- **One signature covers nested transfers.** A contract can call `require_auth` for a user and then call the token's `transfer` for that same user within the same authorized invocation (Stellar docs, Authorization). The payee then sees the user as the sender.
- **Muxed destinations.** Since protocol 23 (CAP-67), the Stellar Asset Contract's `transfer` accepts a muxed `M` address as the destination. `transfer_from` and `approve` do not. Whether a transaction memo can accompany a contract-call transaction is not confirmed and is not relied on.
- **Allowance lifetime.** An allowance's `live_until_ledger` cannot be in the past unless the amount is 0, and an expired allowance counts as zero (SEP-41). On testnet, a USDC allowance about 3,110,300 ledgers ahead was accepted in simulation, and about 3,110,500 ahead was rejected. That matches `max_entry_ttl` of 3,110,400 ledgers, about 180 days at the 5-second target close time. Any automatic plan longer than that needs the user to approve again.

### 4.2 Roles

| Role | Can | Cannot |
|---|---|---|
| User | Create goals and enrol; deposit; withdraw within the rules; approve and revoke allowances; stop automatic deposits at any time | Bypass a rule they agreed to |
| Integrator | Choose which options to offer; set the address that receives early-withdrawal penalties on goals created through it; run a keeper | Move or freeze user funds; change a goal's rules after creation |
| Keeper | Trigger a scheduled deposit that is due now, from the user's wallet into that user's own goal | Anything else. Who may act as keeper is set in section 6 |
| Loktin | Only what section 6 defines for pause and upgrade | Move, redirect or freeze user funds |

### 4.3 Target Savings

- **P1 Fixed rules.** Target amount, deadline, cadence, deposit size and the early-withdrawal rule are fixed when a goal is created. No one can change them afterwards. The cadence must be at least the instance's minimum cadence (section 6, C11).
- **P2 Deposits stop at the goal.** A scheduled deposit takes the deposit size, or the amount still missing to reach the target if smaller. Scheduled deposits stop once the target is reached or the deadline has passed.
- **P3 Missed periods.** Amended 2026-10-22 with section 6 (C3). Periods are counted from the goal's start time; period `k` (k = 1, 2, ...) is due at `start + k * cadence` and lasts until `start + (k + 1) * cadence`. Nothing is due at creation.
  - A collection attempt collects the period that is current at that moment, so a keeper that is late but still inside the period collects it.
  - An attempt that fails because the balance or allowance is short does not use up the period. It can be retried by anyone while the period lasts.
  - A period is recorded as missed only once it has ended without a deposit being collected. Missed periods are never collected later.
  - At most one deposit is collected per period. There is no catch-up.
- **P4 Early-withdrawal rule.** Chosen at creation, as one of:
  - **(a) penalty:** a penalty of 0 to 10% of the principal, paid to the integrator's penalty address;
  - **(b) lock:** no withdrawal until the target is reached or the deadline passes.
  The 10% maximum is a product judgment, not a sourced figure.
- **P5 No penalty once earned.** Once the target is reached or the deadline has passed, withdrawal carries no penalty.
- **P6 Full withdrawal only.** A withdrawal pays out the whole balance and closes the goal. With L5, a goal is never closed on a partial payment.
- **P7 Manual deposits.** Allowed at any time while the goal is open, up to the target amount and not beyond.
- **P8 No names on chain.** Goal labels live in the integrator's own app. The contract stores no names.
- **P9 Allowance horizon.** Scheduled deposits draw on a token allowance.
  - The SDK computes the amount and expiry needed, and reports when the app must ask the user to approve again (at most about 180 days ahead, per 4.1).
  - A deposit that falls due after the allowance has expired is recorded as missed.
- **P10 Open goals per user.** At most 20 open goals per user. The number is a product judgment.

### 4.4 Spend & Save

- **P11 Two ways to save.**
  - **Pay and save** is one contract call, signed by the user. It pays the payee (a plain or muxed address) and saves the skim, and the two succeed or fail together. The payee sees the user as the sender.
  - **Save for a spend** is a call signed by the user after a payment made by any other means. The app supplies the spend amount. The contract cannot confirm the spend, but only the user's own money moves, into the user's own savings.
- **P12 Skim formula.** Set per user at enrolment, as one of:
  - a percentage of the spend (1% to 50%);
  - a round-up of the spend to a unit the integrator sets;
  - both, added together.
- **P13 Monthly cap.** An optional cap on the total saved per calendar month (UTC). Once it is reached, skims shrink to fit the cap. The payment itself is never blocked by the cap.
- **P14 A skim never blocks a payment.** If the wallet cannot cover the payment plus the skim, the skim shrinks to what remains, down to zero, and the shortfall is recorded.
- **P15 Destination.** Skims go to either the user's Spend & Save balance or one of the same user's open Target Savings goals. A skim sent to a goal follows that goal's rules. This is the first feature to cut if time runs short.
- **P16 Once-a-month access.**
  - The user chooses a withdrawal day of the month (1 to 28) at enrolment, and may choose the current day.
  - Their withdrawal window is that whole UTC day, every month.
  - A change of withdrawal day only takes effect from the following month.
  - Per G4, the window can open up to 60 seconds early in real time. This is documented.
  - The SDK shows windows in the user's local time.

### 4.5 What the SDK adds

The SDK computes allowances and their expiry, converts withdrawal windows to local time, and previews a skim or a withdrawal before the user signs. None of this changes what the contract allows.

## 5. Revenue and fees

Agreed 2026-10-22. The owner confirmed that no Stellar, Instawards or Nigerian rule limits charging fees on savings.

- **R1 Loktin fee hook.**
  - The contracts include a Loktin fee from the start, set to 0% for this sprint (constraint 7).
  - Precedent: Uniswap shipped a protocol-fee switch that stayed off until governance turned it on (Uniswap docs, Fees). Soroswap's pair contract on Stellar has a `fee_to` recipient (Soroswap source).
- **R2 Charged at withdrawal.**
  - Fees are taken when funds are withdrawn, calculated on the principal withdrawn.
  - Deposits and progress toward a target are never reduced by fees.
  - The withdrawal preview shows every deduction before the user signs.
- **R3 Rate fixed per goal.**
  - Each Target Savings goal and each Spend & Save enrolment stores the Loktin fee rate and the integrator fee rate in force when it was created.
  - Those rates never change for that goal or enrolment. A new Loktin rate applies only to goals and enrolments created afterwards.
  - Precedent: Blend sets its backstop take rate at pool creation (Blend docs). This also follows P1.
- **R4 Hard caps.** The contracts reject:
  - a Loktin fee rate above 1% (100 basis points);
  - an integrator fee rate above 1%.
  Both caps are product judgments. Worst case on an early withdrawal: 10% penalty (P4) plus 1% plus 1%, all shown before the user signs the goal.
- **R5 Integrator fee.**
  - An integrator may set its own fee of 0 to 1% on goals and enrolments created through its app, paid to its own address.
  - The rate and address are part of what the user signs at creation.
- **R6 Fee-admin role.**
  - A dedicated fee-admin role is the only role that can set the Loktin fee rate for future goals (within the cap) and the address Loktin fees are paid to.
  - It holds no other power (L2).
- **R7 No fee on yield.** Loktin takes no fee from any yield source an integrator plugs in.
- **R8 Hosted services are a later phase.**
  - Optional paid hosted services, such as a managed keeper or alerts, are a possible future revenue line. Self-hosting always stays free and complete.
  - Not built in this sprint: the SOW excludes Loktin-hosted services.

## 6. Contract architecture

### 6.1 Deployment, roles, keeper, pause, upgrades, versions, yield slot

Agreed 2026-10-22.

- **C1 Deployments.**
  - Loktin deploys one shared instance of the Target Savings contract and one of the Spend & Save contract, with no yield source. Any integrator may use them.
  - Each goal and enrolment records the integrator that created it, for the penalty and fee address.
  - An integrator that wants yield deploys its own instance of the same Wasm, with its own roles and its yield source set at construction. Loktin operates no yield and earns nothing from integrator-deployed instances.
- **C2 Roles.** Roles use the OpenZeppelin Stellar access control module, which is role based and has a two-step admin transfer with an expiry.
  - **Admin:** grants and revokes roles. Nothing else.
  - **Fee-admin:** see R6.
  - **Pauser:** pause and unpause.
  - **Upgrader:** replace the contract code.

  No role can move, redirect or freeze user funds. On testnet each role is held by a separate key the owner controls. To mainnet standard, the admin and upgrader roles are held by multisig accounts. Stellar applies a classic account's multisig at the medium threshold when a contract calls `require_auth`.
- **C3 Open keeper.**
  - Anyone may call the function that collects a due scheduled deposit. It can only move the due amount from the goal owner's wallet into that owner's goal.
  - There is no keeper role and no keeper allowlist. Integrators run keepers without any permission from Loktin.
  - Together with amended P3, this means an early or hostile call cannot cause a missed period.
- **C4 Pause never traps funds.**
  - Pausing blocks creating goals, enrolling, deposits, scheduled collections, skims and pay-and-save.
  - It never blocks withdrawals or reads. Withdrawals still follow each goal's or enrolment's rules.
  - Pausing is applied per function with the OpenZeppelin pausable module.
- **C5 Upgrades.**
  - The upgrader role can replace the contract code, through the OpenZeppelin upgradeable module.
  - That module does not check that new code has no constructor or that storage stays consistent, so every upgrade needs:
    - its own decision note in `docs/decisions/`;
    - a storage-compatibility test against the previous version;
    - a new version recorded in contract metadata.
  - Public docs state plainly that the upgrader is the one remaining trusted power over the contracts.
  - Before any mainnet deployment, upgrades also require a multisig and a public waiting period. Their design is a recorded decision made before mainnet.
- **C6 Versions.**
  - soroban-sdk 28.0.0 with OpenZeppelin stellar-contracts 0.8.0 (audited; its published crates require soroban-sdk ^28.0.0).
  - The Stellar host accepts contracts built for an older finalized protocol on a newer network (rs-soroban-env, `check_contract_interface_version`), so these contracts run on protocol 29.
  - Move to soroban-sdk 29 once an audited OpenZeppelin release supports it.
  - soroban-sdk 28.0.0 needs Rust 1.91 or newer; the pinned toolchain is 1.99.1.
- **C7 Yield slot, ready but switched off.**
  - Every savings position stores both principal and shares. With no yield source, one share equals one unit of principal and the contract acts as plain escrow.
  - The yield-source interface is defined now.
  - In this sprint the constructor rejects any yield source. Enabling one later is an upgrade with its own design step and tests (including protection against known attacks on share-based vaults), not a redesign.
- **C8 One token per instance.** Fixed at construction. Loktin's instances use Circle's testnet USDC.
- **C9 Rounding favours the user.** Every fee and penalty calculation rounds any fraction down.
- **C10 No integrator registry.** The integrator's address and fee rate are supplied when a goal or enrolment is created, signed by the user as part of that call, and checked against the caps by the contract.
- **C11 Minimum cadence.**
  - Each Target Savings instance takes a minimum cadence at construction, fixed afterwards.
  - Loktin's testnet instance uses 86,400 seconds (1 day). Throwaway instances on CI's local network use 60 seconds (section 9, T8).

### 6.2 Storage, functions, events, errors, threat model

Agreed 2026-10-22.

- **S1 Storage and TTL.**
  - Instance storage holds configuration only: token, yield source (none), Loktin fee rate for new goals, fee recipient, next id, schema version, and the OpenZeppelin role and pause state.
  - Persistent storage holds one entry per open goal, one entry per user listing that user's open goal ids (at most 20), and one entry per Spend & Save enrolment.
  - No temporary storage.
  - Every state-changing call extends instance TTL and the TTL of each entry it touches to the network maximum (testnet 3,110,400 ledgers, about 180 days) whenever the remaining TTL is below about 30 days (518,400 ledgers). Both numbers are judgments, and their cost is measured in section 9.
  - An archived open goal is restored automatically by the next call that simulates it (protocol 23 and later), at that caller's cost. Keepers also extend open goals nearing expiry with ExtendFootprintTTLOp (section 8).
- **S2 Closed goals are deleted.**
  - When a goal closes, its entry and its id in the owner's list are removed. A final event carries every figure.
  - History lives in events and in the integrator's own records. Public RPC keeps only about 7 days of history, and the docs say so.
  - Deleting also means paging never touches archived closed goals (archived persistent entries can only be restored, never re-created).
- **S3 Versioned records.** Goal and enrolment records are stored as versioned enums, and the instance holds a schema version, as the OpenZeppelin upgradeable guidance advises. An upgrade must read every earlier version.
- **S4 Functions.**
  - Target Savings:
    - user: `create_goal(owner, target, deadline, cadence, deposit_size, rule, integrator, integrator_fee_bps, allowance)`, `deposit(owner, goal_id, amount)`, `withdraw(owner, goal_id)`;
    - `create_goal`'s optional `allowance` (amount and expiry ledger) sets the token allowance for scheduled deposits within the same call and signature. Renewing an allowance later is a direct call to the token's `approve`.
    - anyone: `collect(goal_id)`;
    - reads: `goal`, `user_goals` (returns the full records of the user's open goals, at most 20), `open_goals(from_id, limit)`, `next_id`, `preview_withdraw`, configuration reads;
    - fee-admin: `set_loktin_fee`, `set_fee_recipient`;
    - pauser: `pause`, `unpause`;
    - upgrader: `upgrade`;
    - admin: OpenZeppelin role management.
  - Spend & Save:
    - user: `enroll`, `update_settings`, `pay_and_save(user, integrator, to, amount)` where `to` may be a plain or muxed address, `save_for_spend(user, integrator, spent)`, `withdraw(user, integrator, amount)`, `close(user, integrator)`;
    - reads: `enrollment`, `preview_skim`, `preview_withdraw`, `next_window`;
    - the same role functions as Target Savings.
  - Exact argument types are fixed in the code and documented with the SDK (section 7).
- **S5 Paging.** Goal ids are sequential. `open_goals(from_id, limit)` returns scheduling data for ids that still exist, skipping deleted ones, with `limit` at most 50. Testnet allows at most 200 entries read per transaction.
- **S6 Events.** Event names and fields are a documented public interface.
  - Target Savings: `goal_created`, `deposited` (manual, scheduled or skim), `missed` (number of periods), `withdrawn` (amount, penalty, Loktin fee, integrator fee), `goal_closed`.
  - Spend & Save: `enrolled`, `settings_updated`, `saved` (spend, skim, destination, shortfall), `paid`, `withdrawn`, `enrollment_closed`.
  - Both: `loktin_fee_set`, `fee_recipient_set`, plus the OpenZeppelin role, pause and upgrade events.
- **S7 Error codes.** 1 to 99 shared, 100 to 199 Target Savings, 200 to 299 Spend & Save. Each code is documented and never reused. OpenZeppelin uses 1000 and above (pausable 1000 to 1001, access control 2000 to 2010).
- **S8 Code safety.**
  - Checked arithmetic on every amount.
  - State is written before any token call.
  - The design does not rely on the host blocking reentrancy, a claim not confirmed in Stellar's docs.
  - UTC day of month and month number come from the ledger timestamp using Howard Hinnant's civil_from_days algorithm, unit-tested against known dates.
- **S9 Spend & Save enrolments.**
  - One enrolment per user per integrator, at most 5 per user.
  - Within the withdrawal window the user may withdraw any amount up to the balance.
  - Skim rate, monthly cap and destination may change at any time. The withdrawal day change follows P16. Fee rates stay fixed (R3).
  - A user may close an enrolment once its balance is zero.
- **S10 Skims into a goal.**
  - A skim sent to a Target Savings goal is an ordinary deposit by the user into their own goal, under the same signature. It is capped at the amount the goal still needs.
  - Any remainder, and any skim aimed at a goal that is full or closed, goes to the Spend & Save balance.

### 6.3 Threat model

Built on Stellar's STRIDE template. Reviewed at every check under "did we do a good job".

| ID | Threat | Remediation |
|---|---|---|
| Spoof.1 | Someone acts as a user | `require_auth` on every user function; negative tests (L16) |
| Spoof.2 | A fake integrator address | Receives only fees the user signed for, within caps (R4, C10) |
| Tamper.1 | Malicious upgrade | Upgrader role; multisig and waiting period before mainnet (C5) |
| Tamper.2 | Token swapped | Token fixed at construction (C8) |
| Tamper.3 | Upgrade misreads stored data | Versioned records and a storage-compatibility test (S3, C5) |
| Repudiate.1 | A user denies a deposit or withdrawal | An event for every money movement, plus the token's transfer events |
| Info.1 | Savings amounts are public on chain | Unavoidable on a public ledger; no names stored (P8); integrator docs say so |
| DoS.1 | Hostile early collection calls | Amended P3 |
| DoS.2 | Stolen pauser key | Pause cannot block withdrawals (C4) |
| DoS.3 | Spam goals | 20 open goals per user, creator pays rent, bounded paging (P10, S5) |
| DoS.4 | An open goal is archived | Automatic restore and keeper extensions (S1) |
| DoS.5 | Public RPC outage | Integrator chooses the RPC endpoint (G8) |
| Elevation.1 | Admin grants itself upgrader | Admin held by a multisig before mainnet; single key accepted on testnet |
| Elevation.2 | Integrator raises its fee | Fee rates fixed at creation (R3) |
| Elevation.3 | Fee-admin raises Loktin's fee | New goals only, capped at 1% (R3, R4) |

## 7. SDK architecture

Agreed 2026-10-22.

Facts this section rests on, from `@stellar/stellar-sdk` 17.x source and npm metadata:

- The SDK's wallet signing types are:
  - `SignTransaction(xdr, { networkPassphrase, address, submit, submitUrl }) -> { signedTxXdr, signerAddress?, error? }`;
  - `SignAuthEntry(authEntry, opts) -> { signedAuthEntry, signerAddress?, error? }`.
  
  These match the SEP-43 wallet interface (Draft), Freighter and Stellar Wallets Kit.
- Without a `publicKey`, the contract client simulates against a local placeholder account and makes no account lookup. A read is one RPC call.
- `sendTransaction` returns PENDING, DUPLICATE, TRY_AGAIN_LATER or ERROR. The outcome is then read with `getTransaction`.
- The ESM build uses no Node `Buffer`.
- 17.3.0 is less than 7 days old as of 2026-10-22. 17.2.1 (2026-10-01) is the newest allowed, and requires Node 22.12 or later.

Decisions:

- **K1 One package with sections.** `@loktin/sdk` (core), `@loktin/sdk/target-savings`, `@loktin/sdk/spend-save` and `@loktin/sdk/keeper` (section 8), as subpath exports.
- **K2 Peer dependency.** `@stellar/stellar-sdk` `^17.2.1` is a peer dependency, so the integrator's app and the SDK share one copy (the package is about 51.6 MB unpacked).
- **K3 Injected signer.**
  - The integrator passes `signTransaction` and optionally `signAuthEntry` in the types above.
  - A Node signer built from a secret key is offered only for the keeper and tests. It never appears in browser examples.
- **K4 Generated contract code.**
  - Contract client code is generated from the built contract Wasm with the pinned Stellar CLI, and committed.
  - CI regenerates it and fails on any difference.
  - If the generated code needs a `Buffer` polyfill, the build stops for an owner decision.
- **K5 Write flow.**
  - Every write follows the same steps: validate inputs locally, look up the account, simulate, sign through the injected signer, send, then wait for the outcome.
  - Archived entries are restored automatically through simulation (section 6, S1).
  - On the first write, the SDK confirms that the RPC's network passphrase matches the configured network.
- **K6 Retries without double actions.**
  - TRY_AGAIN_LATER: the same signed transaction is resent up to 3 times with increasing delays.
  - Waiting for an outcome times out: the SDK returns a pending result with the transaction hash, and never builds a new transaction by itself.
  - Reads are retried up to 3 times on network errors.
- **K7 Typed errors.** Every error has a stable code and type:
  - invalid input, caught before any network call;
  - contract error, mapped from the section 6 codes;
  - signer refused;
  - RPC or network failure;
  - pending, outcome unknown yet.
- **K8 Amounts.** All amounts are `bigint` in base units (USDC on Stellar has 7 decimals). Helpers convert decimal strings to and from base units. Floating-point numbers are never used for amounts.
- **K9 Read adapter.**
  - A `ReadAdapter` interface covers every read.
  - The built-in default reads straight from the chain through simulation. An integrator may supply its own, such as an indexer.
  - Writes always go to the chain.
- **K10 Configuration.**
  - `createLoktin({ network, rpcUrl?, contracts?, signer?, publicKey?, readAdapter? })`.
  - `"testnet"` includes Loktin's testnet contract addresses. An integrator's own deployment (C1) passes its own addresses.
  - There is no mainnet configuration in this sprint.
- **K11 Helpers.** Withdrawal preview, skim preview, allowance amount and expiry, and withdrawal windows in the user's local time (section 4.5).
- **K12 Browser targets.**
  - Output targets browsers that support ES2022 and BigInt.
  - Browser support is claimed in the docs only after the reference app smoke test in a real browser (section 9, T11).

## 8. Keeper tooling

Agreed 2026-10-22.

Facts this section rests on:

- **Sequence numbers.** An account's transactions must be submitted one sequence number apart. Separate channel accounts as transaction sources allow a higher rate (Stellar docs, Channel accounts).
- **Fees.** Smart contract transactions pay a resource fee plus an inclusion fee. Under surge pricing a low bid may not be included (Stellar docs, Fees).
- **RPC reads.**
  - `getLedgerEntries` takes up to 200 keys and returns `liveUntilLedgerSeq`.
  - `getLatestLedger` returns the sequence and close time.
  - RPC keeps about 7 days of history by default.
- **Container practice.** Docker secrets are mounted as files under `/run/secrets`. Environment variables can leak into logs (Docker Compose docs).
- **Running Node in a container.** Run as the non-root `node` user, set `NODE_ENV=production`, and start with `--init`, because Node is not designed to run as PID 1 (docker-node best practices).
- **Base image.** OpenSSF Scorecard asks for Dockerfile base images pinned by hash.

Decisions:

- **E1 Keeper client** (`@loktin/sdk/keeper`):
  - `scan` reads `next_id`, then pages `open_goals` (at most 50 per call) from a cursor the keeper keeps. It returns goals due now and goals whose TTL is below the threshold.
  - `collect(goalId)` simulates first and submits only if the simulation succeeds.
  - `extend` renews goals near expiry with ExtendFootprintTTLOp.
  - The SOW's "register and query scheduled actions" maps to the keeper's watch settings (integrator filter, cursor) and its scan results. Nothing is registered on chain, because none is needed (C3). The docs say so plainly.
- **E2 Scope.** By default a keeper serves only goals created by its own integrator. An option serves all open goals.
- **E3 Throughput.** One source account by default, with more channel accounts configurable. Every keeper account holds only XLM for fees.
- **E4 Keys.**
  - Keeper keys have no role and no power over funds (L15).
  - The key is read from a file path (a Docker secret). An environment variable is accepted as a documented, weaker fallback.
  - Only public keys ever appear in logs.
- **E5 Run model.**
  - One command runs one pass (scan, collect, extend) and exits.
  - Scheduling is done by the host's scheduler with a cron expression. The template ships examples for Linux crontab, a Kubernetes CronJob with `concurrencyPolicy: Forbid`, and a GitHub Actions schedule.
- **E6 Container.**
  - Two-stage build on `node:24-slim`, pinned by digest.
  - Runs as the non-root `node` user, with `NODE_ENV=production`, started with `--init`, on a read-only root filesystem.
  - Dependabot watches the image.
- **E7 Failures.**
  - Expected skips (not due, already collected, shortfall, paused) are logged as skips.
  - Any unexpected error makes the run exit non-zero, and the next scheduled run tries again.
- **E8 Logs.** One JSON line per action on standard output: goal id, action, transaction hash, outcome. Never secrets.
- **E9 Configuration.** Environment variables only:
  - RPC URL;
  - network;
  - contract addresses;
  - integrator filter;
  - secret file path;
  - number of channel accounts;
  - page size (at most 50);
  - maximum fee.
- **E10 Fee ceiling.** A goal whose simulated fee exceeds the configured maximum is skipped and retried on the next run. The default ceiling is set from section 9 measurements.
- **E11 Evidence.** The keeper's log lines are the source for the SOW keeper evidence: every collected deposit with its transaction hash.

## 9. Testing and performance

Agreed 2026-10-22. Stellar's testing guides (unit, auth, events, integration, test snapshots, fuzzing, mutation testing) are the reference.

- **T1 Contract unit tests.**
  - Cover every public function, its success path and every error code, plus boundary values.
  - Assert the events emitted.
  - Commit the generated test snapshots.
- **T2 Authorization tests (L16).**
  - Assert exactly which address authorized each call, with `env.auths()`.
  - Prove that a stranger's call is refused.
  - No blanket auth mocking in these tests.
- **T3 Property tests** (proptest) over random sequences of create, deposit, collect, skim and withdraw. After every step these must hold:
  - the sum of all recorded balances equals the contract's token balance;
  - every payout plus its fees and penalty equals the principal withdrawn;
  - no goal closes while anything is owed (L5);
  - at most one collection per period (P3);
  - skims never exceed the monthly cap (P13).
- **T4 Integration tests.** Spend & Save depositing into a real Target Savings contract (P15), using a real Stellar asset contract created in the test environment.
- **T5 TTL tests.** Touched entries are extended, and an archived open goal can be restored.
- **T6 Upgrade tests.** Only the upgrader can upgrade, and stored records remain readable after an upgrade (C5).
- **T7 SDK tests.** A fake RPC is injected through the stellar-sdk `server` option. The tests cover:
  - error mapping;
  - amount helpers;
  - local-time windows;
  - TRY_AGAIN_LATER retries;
  - a timeout returning pending without a second transaction.
- **T8 End-to-end tests in CI on a private local network.**
  - CI runs `stellar/quickstart` with `--local --limits testnet`, pinned by digest.
  - It creates throwaway accounts funded by the local Friendbot and issues a test token.
  - It deploys fresh instances with a 60-second minimum cadence and runs every user flow through the SDK, plus the keeper template container once.
  - Nothing touches testnet, and no key outlives the run.
- **T9 Testnet runs.** The owner deploys and runs scripted smoke flows with their own keys. Results are checked read-only.
- **T10 Budgets.**
  - Each contract function's resource use, measured in tests, stays under 25% of the per-transaction limits, and a 50-goal page fits within them.
  - On testnet, the owner's runs record read latency, end-to-end write latency, fees per function and TTL extension cost.
  - The compressed SDK bundle size is measured once, then CI fails on growth above 10%.
  - Keeper goals per minute are measured on the local network.
  - The 25% and 10% thresholds are judgments.
- **T11 Browser.** No browser test runner this sprint (Vitest browser mode needs Playwright or WebdriverIO). The SDK is smoke-tested in a real browser through the reference app, and the result is recorded.
- **T12 Mutation testing.** `cargo mutants` runs on the contracts once before the stable release. Every surviving mutant gets a test or a written reason. Not in CI.
- **T13 Fuzzing.** Deferred to before any mainnet deployment (it needs nightly Rust and long runs). The plan records it as required for mainnet.

## 10. Release, docs and evidence

Agreed 2026-10-22.

- **V1 Versions.**
  - Previews are `0.y.z`, published under the npm `next` tag. Semantic Versioning treats 0.y.z as initial development.
  - The first stable version is `1.0.0`, at the end of the sprint. Its documentation states testnet only and names the upgrade authority (C5).
- **V2 Publishing.**
  - Releases are published from GitHub Actions with npm trusted publishing and provenance, once the repo is public.
  - The owner creates the `loktin` npm organisation with two-factor authentication and configures the trusted publisher. A new trusted-publisher configuration must complete its first publish within 2 days or it expires.
  - If npm requires a first manual publish for a new package, the owner does it once. That one version has no provenance.
- **V3 Release flow.** The owner pushes a version tag. CI runs every check, publishes, and creates a GitHub release from the changelog.
- **V4 Build verification.**
  - Release Wasm is built in GitHub Actions following SEP-55 (Draft): a metadata entry in the Wasm plus a GitHub artifact attestation.
  - Loktin's testnet instances are deployed from exactly that Wasm.
  - If time runs short, the evidence records each Wasm hash and commit instead.
- **V5 Deploy runbook (owner).**
  - Create keys by alias: admin, fee-admin, pauser, upgrader, deployer, keeper. Fund them from Friendbot.
  - Deploy both contracts with: Circle testnet USDC, a 1-day minimum cadence, a 0% Loktin fee, and the roles assigned.
  - Record the addresses in the SDK's testnet configuration through a pull request.
  - The reviewer then checks configuration, role holders and the Wasm hash against the attested build, read-only.
- **V6 Testnet smoke script.** A script runs every user flow through the SDK with a test-user key funded from Friendbot and Circle's testnet USDC faucet. It writes every transaction hash to the evidence file. The owner runs it.
- **V7 Evidence keeper.**
  - A scheduled GitHub Actions workflow in this repo runs the keeper template container hourly, at an off-peak minute. GitHub's shortest schedule interval is 5 minutes, and runs can be delayed or dropped at busy times.
  - The keeper key is a repository Actions secret holding only XLM.
- **V8 Keeper template location.** It stays a folder in this repo, with "copy this folder" instructions. The evidence links to the folder.
- **V9 Docs.**
  - An SDK section on docs.loktin.xyz (repo `Lokt-In/loktin-docs`):
    - quickstart;
    - a guide per primitive;
    - keeper guide;
    - security and trust page (upgrade authority, no yield, fees);
    - API reference built from the code by TypeDoc.
  - The current yield wording on that site ("Plan. Lock In. Earn." and yield through Blend) is removed in the same release.
  - The owner deploys the docs.
- **V10 Reference integration.**
  - A separate public repo, `Lokt-In/loktin-sdk-example`: Vite and TypeScript, no framework, both primitives, signing through Stellar Wallets Kit.
  - The owner deploys a demo to a subdomain such as demo.loktin.xyz.
  - It doubles as the real-browser smoke test (T11).
- **V11 Walkthrough.** Drafted in the owner's voice. The owner publishes it where they choose.
- **V12 Evidence document.** `docs/evidence.md`, plus a copy for the chapter lead. It maps each SOW deliverable to:
  - the npm link;
  - the repo;
  - transaction hashes on stellar.expert;
  - the keeper log;
  - the docs;
  - the demo.

## 11. Build order

Agreed 2026-10-22. Each part: build, review, commit and merge by the owner. Dates are targets.

| Part | Content | Target |
|---|---|---|
| B1 | Repo scaffold | Done |
| B2 | Rust workspace, `contracts/common`, Rust CI | 23 Oct |
| B3 | Target Savings contract (sections 4 to 6) with tests T1 to T6 | 25 Oct |
| B4 | Spend & Save contract, including P15, with tests | 27 Oct |
| B5 | Release Wasm build with SEP-55 attestation, deploy and smoke scripts. Owner deploys to testnet; reviewer verifies | 28 Oct |
| B6 | SDK core and both primitive modules (K1 to K12) with tests T7. Repo goes public and preview `0.1.0` is published, on the owner's go-ahead | 30 Oct |
| B7 | Local-network end-to-end tests in CI (T8). Owner runs the testnet smoke script and creates the evidence goals | 31 Oct |
| B8 | Keeper client and template; hourly evidence keeper. Owner adds the keeper secret | 1 Nov |
| B9 | Docs in `loktin-docs` (second builder session) | 2 Nov |
| B10 | Reference app repo and demo (second builder session) | 3 Nov |
| B11 | Measurements (T10), mutation testing (T12), evidence document, walkthrough draft, `1.0.0` release | 4 Nov |
| Buffer | | 5 Nov |

- **Critical path.** The keeper evidence needs collected deposits on testnet. With a 1-day minimum cadence, goals created by 31 October give several collections before 4 November. B5 to B7 must not slip.
- **Second builder session.** From B9, a second builder session works in the docs and example repos. It never touches this repo's files.
- **Cut order, fallback only.** Items are cut only by the owner's decision, made at a check when a part has missed its target. Until then, everything is built. If cuts are needed, the order is:
  1. skims into goals (P15);
  2. SEP-55 attestation, replaced by recorded hashes (V4);
  3. the keeper container run in CI;
  4. the live demo (the repo stays);
  5. mutation testing, moved to before mainnet.
  
  Never cut: both primitives, the keeper template and its evidence, the test suite, the docs, the npm package.
