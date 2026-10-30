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
4. **No promised yield.** The SDK ships no yield code and no yield functions. The contracts have a slot for a yield source that is empty and switched off by default. An integrator may program their own yield source into it. Nothing in this repo, the SDK or the SDK's docs states or implies a return. Amended 2026-10-30 (W118): the Loktin app's own pages on docs.loktin.xyz are outside this plan and stay as they are.
5. **Networks.** Deploy to testnet only during this sprint. Build to mainnet standard: key handling, roles, upgrades and tests are designed as if for mainnet.
6. **New contract addresses.** The new contracts are new deployments. Nothing migrates from the old contracts.
7. **Fees.** Any early-withdrawal penalty goes to an address the integrator sets. Loktin takes no fee in this sprint. A revenue model for Loktin is planned separately and must be possible within the contract design.
8. **Runtimes.** Browser and Node.
9. **Publishing.** Nothing is published until the owner says so.
   - The repo goes public at B5, just before the release build and testnet deploy. GitHub artifact attestations (V4) work only for public repositories on the Team plan, so this is what lets the deployed contracts be attested. Amended 2026-10-22 (W46).
   - The first npm preview is published once the core client and signer injection work against testnet (B6), on the owner's go-ahead.
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
| Stellar CLI | Pinned to 28.1.0 for builds and deploys. Contracts are built only with `stellar contract build`: soroban-sdk 28's build script refuses a plain cargo wasm build. CI downloads the CLI from its GitHub release and verifies the release asset's sha256 digest. Never set `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2` by hand. |
| Test snapshots | Committed, as T1 requires. `**/test_snapshots/` is excluded from Prettier so the files stay exactly as the SDK writes them. |
| Age exemptions | Recorded in `docs/decisions/`. The only one: stellar-access, stellar-contract-utils and stellar-macros at exactly 0.8.0 (published 2026-10-20), because C6 requires them. They are an audited release published by a crate owner. |
| Node | Development and releases use Node 24, because its bundled npm supports `min-release-age` (added in npm 11.10.0; Node 22 bundles npm 10.9). `.nvmrc` holds 24. CI runs the test suite on Node 22, 24 and 26. Published `engines.node` is `>=22.12.0`. |
| Package manager | npm workspaces. `package-lock.json` is committed and CI installs with `npm ci`. |
| `.npmrc` | `ignore-scripts=true`, `save-exact=true`, `min-release-age=7`. A package that needs an urgent fix may be listed in `min-release-age-exclude`, and that exemption is a recorded decision. A dependency that cannot work without an install script is a decision for the owner, never a silent change. |
| TypeScript | 6.0.x, strict mode. Not 7.x until typescript-eslint supports it (8.72.0 supports typescript below 6.1.0). `skipLibCheck` stays false. The SDK package compiles with `lib: ["ES2022", "DOM"]`, because `@stellar/stellar-sdk` 17.2.1's own type files use DOM types (`Headers`, `URL`, `AbortSignal`, `RequestInit`). The SDK package does not use @types/node. Amended 2026-10-23 (W49). Only the end-to-end tests use `@types/node` (pinned exactly, enabled in their own tsconfig alone), so the shipped SDK never sees Node types. Amended 2026-10-26 (W74). |
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
  - A repo `.gitleaks.toml` extends gitleaks' default rules and allowlists only Stellar public account and contract addresses (56 characters starting with G or C). Public addresses are not secrets, and secret keys (starting with S) are still caught. Amended 2026-10-24 (W55).
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
- **L6 No promised rate.** No contract, SDK function, doc or event states or implies a rate of return. Yield exists only through the opt-in slot, off by default. (Section 6.) "Doc" means this repo's docs and the SDK section of docs.loktin.xyz, not the Loktin app's pages there (W118).
- **L7 Defined catch-up behaviour.** What happens after missed scheduled periods (catch up or skip and record) is an explicit rule. (Section 4.)
- **L8 Defined time windows.** Every time window, including the once-a-month access in Spend & Save, has defined boundaries that allow for the ledger close time running up to 60 seconds ahead. (Section 4.)
- **L9 The host's payment flow is respected.** How a skim relates to the host's own payment is an explicit design choice. (Section 4.)
- **L10 Storage renewal plan.** Every kind of stored data (instance, persistent, temporary) has a written TTL renewal plan. Stellar docs: instance storage shares the contract instance's TTL; archived persistent and instance entries can be restored automatically since protocol 23 when simulation adds them to the restore list, with normal rent and fees. (Section 6.)
- **L11 Bounded storage.** No per-user list grows without limit. User-supplied strings have length limits. Discovery uses events or paging. (Section 6.)
- **L12 No panics for expected failures.** Every expected failure returns a stable, documented error code. No `unwrap()` on stored configuration. No unused error codes, except that every contract reserves the full shared range 1 to 99 (S7), even codes it never returns.
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
- **P2 Deposits stop at the goal.** A scheduled deposit takes the deposit size, or the amount still missing to reach the target if smaller. Scheduled deposits stop once the target is reached or the deadline has passed. The deadline second itself is inside the goal: a collection at exactly the deadline is allowed, and any collection after it is refused, even for a period that fell due before it.
- **P3 Missed periods.** Amended 2026-10-22 with section 6 (C3). Periods are counted from the goal's start time; period `k` (k = 1, 2, ...) is due at `start + k * cadence` and lasts until `start + (k + 1) * cadence`. Nothing is due at creation.
  - A collection attempt collects the period that is current at that moment, so a keeper that is late but still inside the period collects it.
  - An attempt that fails because the balance or allowance is short does not use up the period. It can be retried by anyone while the period lasts.
  - A period is recorded as missed only once it has ended without a deposit being collected. Missed periods are never collected later.
  - At most one deposit is collected per period. There is no catch-up.
- **P4 Early-withdrawal rule.** Chosen at creation, as one of:
  - **(a) penalty:** a penalty of 0 to 10% of the principal, paid to the integrator's penalty address;
  - **(b) lock:** no withdrawal until the target is reached or the deadline passes.
  The 10% maximum is a product judgment, not a sourced figure.
- **P5 No penalty once earned.** Once the target is reached, or from the deadline second onwards, withdrawal carries no penalty.
- **P6 Full withdrawal only.**
  - A withdrawal pays out the whole balance and closes the goal. With L5, a goal is never closed on a partial payment.
  - Under a lock rule, withdrawing before the target or deadline returns a Locked error when principal is above 0.
  - A goal with nothing deposited (principal 0) can be closed at any time, under any rule. This frees one of the user's open-goal slots.
  - Zero-amount transfers are skipped.
- **P7 Manual deposits.** Allowed at any time while the goal is open, up to and including its deadline second, up to the target amount and not beyond. A deposit above what the goal still needs is rejected, never trimmed.
- **P8 No names on chain.** Goal labels live in the integrator's own app. The contract stores no names.
- **P9 Allowance horizon.** Scheduled deposits draw on a token allowance.
  - The SDK computes the amount and expiry needed, and reports when the app must ask the user to approve again (at most about 180 days ahead, per 4.1).
  - The amount covers only the scheduled deposits due before the allowance expires, capped at what the goal still needs. The expiry is the deadline's ledger (estimated at 5 seconds per ledger, plus one day of margin), capped at the latest ledger the network allows. When a goal outlives its allowance, the SDK returns a renew-by date 7 days before the expiry. Amended 2026-10-24 (W57).
  - Amended 2026-10-29 (W116): an owner has one allowance for Target Savings, and a new approval replaces it (SEP-41). So `createGoal` with `'auto'` and `renewAllowance` read the owner's open goals and approve the sum of each goal's amount (the new goal's included), until the latest of their expiry ledgers, with the earliest renew-by date if any. An explicit amount or `'none'` is unchanged, and the docs say an explicit approval replaces the whole allowance. `createGoal('auto')` costs one more read.
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
  
  The round-up part is `(unit - spend % unit) % unit`, so a spend that is already a whole number of units adds nothing.

  A skim never exceeds the spend it is taken from. After the two parts are added, the skim is cut to the spend, before the monthly cap and the wallet check. Without this, an extreme round-up unit could move a user's whole wallet into savings and lock it until their withdrawal day.
- **P13 Monthly cap.** An optional cap on the total saved per calendar month (UTC). Once it is reached, skims shrink to fit the cap. The payment itself is never blocked by the cap.
- **P14 A skim never blocks a payment.** If the wallet cannot cover the payment plus the skim, the skim shrinks to what remains, down to zero, and the shortfall is recorded. A skim of zero moves nothing but still emits `saved` with the shortfall, so the app can show it.
- **P15 Destination.** Skims go to either the user's Spend & Save balance or one of the same user's open Target Savings goals. A skim sent to a goal follows that goal's rules. This is the first feature to cut if time runs short.
- **P16 Once-a-month access.**
  - The user chooses a withdrawal day of the month (1 to 28) at enrolment, and may choose the current day.
  - Their withdrawal window is that whole UTC day, every month.
  - A change of withdrawal day only takes effect from the following month. Until then the current month keeps the old day.
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
  - A withdrawal pays only the user. Penalties and integrator fees are credited to the integrator, and Loktin fees to the fee recipient, as accrued fees that each recipient claims itself (S4). So no third party can block a user's withdrawal, for example by having no trustline for the token. Accrued fees never expire. Amended 2026-10-26 (W63).
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

  No role can move, redirect or freeze user funds. Role checks call OpenZeppelin's `ensure_role` and then `require_auth` directly, with the role names from `contracts/common`, so each name is defined in one place. (The `only_role` macro accepts only a string literal.) On testnet each role is held by a separate key the owner controls. To mainnet standard, the admin and upgrader roles are held by multisig accounts. Stellar applies a classic account's multisig at the medium threshold when a contract calls `require_auth`.
- **C3 Open keeper.**
  - Anyone may call the function that collects a due scheduled deposit. It can only move the due amount from the goal owner's wallet into that owner's goal.
  - There is no keeper role and no keeper allowlist. Integrators run keepers without any permission from Loktin.
  - Together with amended P3, this means an early or hostile call cannot cause a missed period.
- **C4 Pause never traps funds.**
  - Pausing blocks creating goals, enrolling, deposits, scheduled collections, skims and pay-and-save. Settings updates move no money and are not blocked.
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
  - The first upgrade (W64): `contracts-v0.2.0` adds accrued fees (W63) to the live testnet contracts in place, so their addresses stay the same. It follows every rule above, and the owner runs it with the upgrader key.
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
- **C10 No integrator registry.** The integrator's address and fee rate are supplied when a goal or enrolment is created, signed by the user as part of that call, and checked against the caps by the contract. The contract refuses its own address as an integrator or as the Loktin fee recipient, because funds paid to itself would be held with no record and never withdrawable.
- **C11 Minimum cadence.**
  - Each Target Savings instance takes a minimum cadence at construction, fixed afterwards.
  - Loktin's testnet instance uses 86,400 seconds (1 day). Throwaway instances on CI's local network use 60 seconds (section 9, T8).

### 6.2 Storage, functions, events, errors, threat model

Agreed 2026-10-22.

- **S1 Storage and TTL.**
  - Instance storage holds configuration only: token, yield source (none), Loktin fee rate for new goals, fee recipient, next id, schema version, and OpenZeppelin's admin address and pause flag.
  - OpenZeppelin's own storage is used as the library designs it and is not changed (v0.8.0 source):
    - role membership, counts and role admins are persistent entries that renew themselves to 90 days when read;
    - a pending admin transfer is kept in temporary storage.
    A role entry left unread for 90 days is restored automatically by the next call that simulates it.
  - Persistent storage holds one entry per open goal, one entry per user listing that user's open goal ids (at most 20), and one entry per Spend & Save enrolment.
  - None of our own data uses temporary storage.
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
    - goal ids from 0.3.0 (W75): a goal's id is derived from its owner and the owner's own goal counter (a hash cut to a u64), so `create_goal` only touches the owner's own entries and its storage keys are known when the call is simulated. The shared `NextId` write goes, and with it `next_id` and `open_goals`. Reason: with a shared counter, goal creations by different users in the same ledger conflict, and all but one fail (the key was derived from changing state, which Stellar's docs warn traps the call). Amended 2026-10-26.
    - fee-admin: `set_loktin_fee(bps, caller)`, `set_fee_recipient(address, caller)`;
    - pauser: `pause(caller)`, `unpause(caller)`;
    - upgrader: `upgrade(new_wasm_hash, operator)`;
    - every role function takes the acting address as its last argument, following OpenZeppelin's pattern, and checks its role and its signature;
    - admin: OpenZeppelin role management.
  - Spend & Save:
    - user: `enroll`, `update_settings`, `pay_and_save(user, integrator, to, amount)` where `to` may be a plain or muxed address, `save_for_spend(user, integrator, spent)`, `withdraw(user, integrator, amount)`, `close(user, integrator)`;
    - reads: `enrollment`, `preview_skim`, `preview_withdraw`, `next_window`;
    - the same role functions as Target Savings.
  - Both contracts, accrued fees (W63):
    - `claim_fees(recipient)`: signed by the recipient; pays out everything accrued to it and removes the entry. Not blocked by pause (C4);
    - read: `accrued_fees(recipient)`;
    - accrued fees are held in persistent storage, one entry per recipient, never temporary storage. An untouched entry is archived, never deleted, and restored by the next call that simulates it.
  - Exact argument types are fixed in the code and documented with the SDK (section 7).
- **S5 Paging.** Goal ids are sequential. `open_goals(from_id, limit)` returns scheduling data for ids that still exist, skipping deleted ones, with `limit` at most 50. Testnet allows at most 200 entries read per transaction.
  - From 0.3.0 (W75), sequential paging is replaced by discovery: goals are found from the `goal_created` and `goal_closed` events and from an integrator's own users through `user_goals` (at most 20 records each). This is Stellar's documented events-plus-indexer pattern, and it needs no shared on-chain index. Public RPC keeps about 7 days of events, so whoever indexes them keeps its own store. Amended 2026-10-26.
- **S6 Events.** Event names and fields are a documented public interface.
  - Target Savings: `goal_created`, `deposited` (manual, scheduled or skim), `missed` (number of periods), `withdrawn` (amount, penalty, Loktin fee, integrator fee), `goal_closed`.
  - Spend & Save: `enrolled`, `settings_updated`, `saved` (spend, skim, destination, shortfall), `paid`, `withdrawn`, `enrollment_closed`.
  - Both: `loktin_fee_set`, `fee_recipient_set`, `fees_claimed` (recipient, amount; W63), `upgraded` (new Wasm hash, operator), plus OpenZeppelin's role and pause events. OpenZeppelin's upgrade function emits no event of its own, so `upgraded` is ours. The contract implements OpenZeppelin's `Upgradeable` trait exactly. A contract cannot read the new Wasm's metadata on chain, so the event carries no version string. The version is found by matching the Wasm hash to the attested release build (V4), which anyone can verify.
- **S7 Error codes.** 1 to 99 shared, 100 to 199 Target Savings, 200 to 299 Spend & Save. Each code is documented and never reused. OpenZeppelin uses 1000 and above (pausable 1000 to 1001, access control 2000 to 2010).
- **S8 Code safety.**
  - Checked arithmetic on every amount.
  - State is written before any token call. One recorded exception: Spend & Save's single fallible `try_deposit` into the user's own Target Savings goal runs first, because its result decides where the skim goes. It goes to the fixed `target_savings` address set at construction, and that call never calls back into Spend & Save. All Spend & Save state is then written once, before its own token transfers. The Stellar host rolls back a failed sub-call's storage and events (rs-soroban-env, `frame.rs`), so a refused deposit leaves nothing behind.
  - The design does not rely on the host blocking reentrancy, a claim not confirmed in Stellar's docs.
  - UTC day of month and month number come from the ledger timestamp using Howard Hinnant's civil_from_days algorithm, unit-tested against known dates.
- **S9 Spend & Save enrolments.**
  - One enrolment per user per integrator, at most 5 per user.
  - Within the withdrawal window the user may withdraw any amount from 1 base unit up to the balance.
  - Skim rate, monthly cap and destination may change at any time. The withdrawal day change follows P16. Fee rates stay fixed (R3).
  - A user may close an enrolment once its balance is zero.
- **S10 Skims into a goal.**
  - A skim sent to a Target Savings goal is an ordinary deposit by the user into their own goal, under the same signature. It is capped at the amount the goal still needs.
  - Any remainder, and any skim aimed at a goal that is full, closed, past its deadline or owned by someone else, goes to the Spend & Save balance. Nothing fails because of the destination.
  - Spend & Save calls Target Savings through a client trait in `contracts/common` that lists only `goal` and `deposit`. `Goal` and `WithdrawalRule` live in `contracts/common`, and both contracts use those definitions.
  - Spend & Save uses the fallible calls (`try_goal`, `try_deposit`). Any error from Target Savings, including a paused contract, routes the whole skim to the Spend & Save balance, so a skim never makes `pay_and_save` or `save_for_spend` fail (P14).

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
| DoS.6 | An integrator or fee recipient that cannot receive the token (no trustline, or removed) blocks users' withdrawals; the fee-admin could cause this by setting such a recipient | Withdrawals pay only the user; fees accrue and recipients claim them (R2, S4, W63). Found by the local-network probe on 2026-10-24 |
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
- Without a `publicKey`, the contract client simulates against a local placeholder account and makes no account lookup. A read is one RPC call, measured against the testnet contracts.
- `sendTransaction` returns PENDING, DUPLICATE, TRY_AGAIN_LATER or ERROR. The outcome is then read with `getTransaction`. Stellar's RPC docs say DUPLICATE means the network already has the transaction.
- The library's own `signAndSend` treats every status except PENDING as a failure, with no retry.
- The contract client's `restore` option is off by default. Stellar RPC simulates contract calls with automatic restore of archived entries and returns no separate restore step for them (stellar-rpc source and changelog).
- When a token call fails inside our contract, the top-level error names our contract but carries the token's code. The simulation's diagnostic events, oldest first, show which contract raised it. Token error codes are 2 to 15 (rs-soroban-env), so 2 to 5 overlap our shared codes.
- The package root also loads Horizon, federation, webauth and the bindings generator. The `/contract`, `/rpc`, `/base` and `/xdr` subpaths do not.
- The ESM build uses no Node `Buffer`.
- 17.3.0 is less than 7 days old as of 2026-10-22. 17.2.1 (2026-10-01) is the newest allowed, and requires Node 22.12 or later.

Decisions:

- **K1 One package with sections.** `@loktin/sdk` (core), `@loktin/sdk/target-savings`, `@loktin/sdk/spend-save` and `@loktin/sdk/keeper` (section 8), as subpath exports.
  - The SDK imports only the `/contract`, `/rpc`, `/base` and `/xdr` subpaths of `@stellar/stellar-sdk`, never its root, so browser bundles stay small. A lint rule enforces this. Amended 2026-10-23 (W52).
- **K2 Peer dependency.** `@stellar/stellar-sdk` `^17.2.1` is a peer dependency, so the integrator's app and the SDK share one copy (17.2.1 is about 50.9 MB unpacked).
- **K3 Injected signer.**
  - The integrator passes `signTransaction` and optionally `signAuthEntry` in the types above.
  - A Node signer built from a secret key is offered only for the keeper and tests. It never appears in browser examples.
- **K4 Contract spec, not generated client code.** Amended 2026-10-22 (W39).
  - The Stellar CLI 28.1.0 TypeScript bindings template does several things we don't want:
    - imports the `buffer` package and sets `window.Buffer` globally;
    - re-exports all of `@stellar/stellar-sdk`;
    - depends on stellar-sdk ^16;
    - maps bytes to `Buffer`.
    So generated client code is not shipped.
  - Instead, the contract spec entries are extracted from the built Wasm and committed as base64 strings. stellar-sdk 17's `contract.Spec` accepts base64 entries and offers `Spec.fromWasm`.
  - The SDK builds `contract.Client` from that spec, and the hand-written typed modules (K1) wrap it.
  - CI re-extracts the spec from freshly built Wasm and fails on any difference.
- **K5 Write flow.** Amended 2026-10-23 (W51).
  - Every write follows the same steps: validate inputs locally, look up the account, simulate, sign through the injected signer, send, then wait for the outcome.
  - Reads are built without the user's address, so they cost one RPC call. Writes use the user's address, so the account is looked up.
  - Archived entries are restored automatically through simulation (section 6, S1). The contract client's `restore` option stays off, so the user is never asked to sign a separate restore transaction. If a restore step is ever reported, the SDK returns a typed error.
  - On the first write, the SDK confirms that the RPC's network passphrase matches the configured network.
  - Local validation repeats every contract check that needs no chain data, such as amounts, rates, days and deadlines, and fails before any network call. Checks that need chain data, such as the minimum cadence, the open-goal limit or whether an enrolment exists, stay with the contract, and simulation reports them before the user signs. Amended 2026-10-24 (W59).
- **K6 Retries without double actions.** Amended 2026-10-23 (W50), 2026-10-26 (W77, W81).
  - The SDK uses the contract client to build, simulate and sign, and sends and polls the transaction itself.
  - PENDING or DUPLICATE: the SDK polls for the outcome.
  - TRY_AGAIN_LATER: the same signed transaction is resent up to 3 times, after 1, 2 and 4 seconds.
  - Waiting for an outcome times out after 60 seconds: the SDK returns a pending result with the transaction hash and the time the transaction stops being valid, and never builds a new transaction by itself.
  - Reads are retried up to 3 times on network errors.
  - The steps of a write before signing are retried the same way: the network check, the account lookup and the simulation. Nothing is signed or sent before them, so a retry can't double an action. A network passphrase mismatch and a contract error from simulation are never retried. stellar-sdk reports every failed account lookup as "Account not found", so a failed request and a missing account look the same; an account that really doesn't exist gets its error after the retries, about 3.5 seconds. Amended 2026-10-26 (W77).
  - Every RPC request has a time limit, 30 seconds by default, set with `requestTimeoutMs`. stellar-rpc caps a request's execution at 25 seconds by default, so the limit never cuts off an answer a healthy RPC would still give. stellar-sdk 17.2.1 sets no limit (its `Server` ignores the `timeout` option), and Node's fetch would wait up to 300 seconds. A request that runs out of time counts as a network error: reads and the steps before signing retry it, a send whose request runs out of time returns a pending result (the transaction may have arrived), and a status check is simply tried again. The wait for an outcome can then run past 60 seconds by at most one time limit. The limit applies to the RPC connection the SDK builds; an integrator who passes its own `server` keeps its own settings. Amended 2026-10-26 (W81).
- **K7 Typed errors.** Every error has a stable code and type. Amended 2026-10-23 (W48):
  - invalid input, caught before any network call;
  - contract error, mapped from the section 6 codes;
  - token error, mapped from the Stellar Asset Contract's codes;
  - unknown contract error, for any other contract;
  - signer refused;
  - RPC or network failure;
  - transaction failed on chain;
  - pending, outcome unknown yet.

  Each error is attributed to the contract that raised it, read from the simulation's diagnostic events, so a token code is never shown as one of ours. docs/errors.md lists the token codes and OpenZeppelin's role transfer codes (2200 to 2203).
- **K8 Amounts.** All amounts are `bigint` in base units (USDC on Stellar has 7 decimals). Helpers convert decimal strings to and from base units. Floating-point numbers are never used for amounts.
- **K9 Read adapter.**
  - A `ReadAdapter` interface covers every read.
  - The built-in default reads straight from the chain through simulation. An integrator may supply its own, such as an indexer.
  - Writes always go to the chain.
- **K10 Configuration.** Amended 2026-10-26 (W81).
  - `createLoktin({ network, rpcUrl?, contracts?, signer?, publicKey?, readAdapter?, server?, requestTimeoutMs? })`. `server` is a stellar-sdk RPC server used instead of one built from `rpcUrl`; `requestTimeoutMs` sets the time limit of every request on the server the SDK builds (K6).
  - `"testnet"` includes Loktin's testnet contract addresses. An integrator's own deployment (C1) passes its own addresses.
  - There is no mainnet configuration in this sprint.
- **K11 Helpers.** Withdrawal preview, skim preview, allowance amount and expiry, and withdrawal windows in the user's local time (section 4.5). Amended 2026-10-24 (W56, W58).
  - Previews come from the contracts' own reads (Target Savings `preview_withdraw`; Spend & Save `preview_skim`, `preview_withdraw` and `next_window`), one RPC call each, so they cannot drift from the contracts.
  - The SDK does its own maths only where no contract read can help: the worst-case split shown before a goal is created, the allowance amount and expiry, local-time display, and the effective withdrawal day shown for an enrolment.
  - Token calls (allowance renewal, balance and allowance reads) go through stellar-sdk's public `Client.from`, which recognises the Stellar Asset Contract after one lookup per SDK instance.
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
  - From 0.3.0 (W75), `scan` builds the keeper's goal list from `goal_created` and `goal_closed` events, kept in the keeper's own store with an event cursor, and from the integrator's own users through `user_goals`. A keeper that was down longer than the RPC's event retention (about 7 days) rebuilds from its integrator's users. Amended 2026-10-26.
  - Until the keeper's own store exists (8b), each pass scans the `goal_created` and `goal_closed` events across the RPC's whole retention window, following the cursor until it stops changing (most pages are empty), keeps goals whose integrator matches, and adds the goals of an optional owner list through `user_goals` (W96, 2026-10-28).
  - Whether a goal is due is worked out from its stored data (a new period has started, the deadline has not passed, the target is not reached); only due goals are collected, one at a time (W97).
  - `collect(goalId)` simulates first and submits only if the simulation succeeds.
  - `extend` renews goals near expiry with ExtendFootprintTTLOp.
  - Amended 2026-10-29 (W111): the keeper's own store and `extend` are dropped for this sprint (every deposit, collect or withdraw renews a goal's entries; an archived goal is restored automatically by the next simulated call; each pass scans the whole retention window, and the owner list covers older goals). The template README says they come later.
  - Amended 2026-10-29 (W113): the scan reads goals with `getLedgerEntries`, up to 200 keys per call (the RPC refuses 201), decoded as `goal()` decodes them.
  - Amended 2026-10-28 (W103): the keeper's own store and `extend` come in 8c. Every deposit, collect or withdraw already renews a goal's entries (threshold about 30 days, extended to the maximum), so only a goal untouched for months needs `extend`.
  - The SOW's "register and query scheduled actions" maps to the keeper's watch settings (integrator filter, cursor) and its scan results. Nothing is registered on chain, because none is needed (C3). The docs say so plainly.
- **E2 Scope.** By default a keeper serves only goals created by its own integrator. An option serves all open goals.
- **E3 Throughput.** One source account by default, with more channel accounts configurable. Every keeper account holds only XLM for fees.
  - One account can send about one transaction per ledger: a second one sent before the first settles gets TRY_AGAIN_LATER (Stellar RPC docs). So throughput grows with channel accounts.
  - Keeper at scale (W72): about 2,000 goals on the local network, a full sweep timed with 1, 2 and 4 channel accounts, and a keeper sizing table (goals per hour per account) published in the keeper docs. Amended 2026-10-26.
  - Amended 2026-10-29 (W112, W114): a collect needs no signature but its sender's, so a channel is simply another keeper account. The key file may hold several keys, one per line, each a channel; one line works as before. `runPass` takes several SDK instances and gives each due goal to the next free channel, each sending one transaction at a time, and checks that every channel account exists before sending anything. The evidence keeper keeps one key. The sizing script runs on the local network only (0.99 s per ledger measured), never on testnet: 2,000 goals across 100 owners (20 each), 60 s cadence, sweeps with 1, 2 and 4 channels, recording sweep time, transactions per ledger and retries. The table converts to testnet's 5 s target (720 ledgers an hour, so at most about 720 collects an hour per channel) and is labelled an upper bound. Not in CI.
  - Amended 2026-10-29 (W117): the local rate is not converted. On the local network a collect's round trip takes about 1.5 one-second ledgers, while on testnet a write took 4.8 s at p50 and 8.8 s at p95 (testnet smoke run, 50 writes). So the sizing doc gives the ceiling (about 720 collects an hour per channel) and an estimate of about 410 to 720 an hour per channel from that measured write time, more channels multiplying it while testnet's ledgers have room, labelled an estimate. The JSON holds measured data only. B11 adds the evidence keeper's real collect times.
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
  - Amended 2026-10-28 (W105, W106): the base is `node:24.22.1-slim`, pinned by its digest when 8b-2 is built, an exception to the 7-day rule because 24.22.1 fixes High-severity TLS and DNS issues; Dependabot, with a 7-day cooldown, proposes later digests. The first stage installs the production packages from the lockfile; the second copies only them and the source and runs `node src/run.ts`. Run with `--init`, `--read-only`, all capabilities dropped and no privilege escalation; the key is mounted read-only as a file under `/run/secrets`. The image is never pushed to a registry; integrators build it.
  - Scheduler examples (E5, W108): a crontab line, a Kubernetes CronJob (no overlapping runs, the key as a file, read-only, non-root) and a GitHub Actions workflow, each parsed in the template's tests. CI checks that the image runs as `node` on a read-only filesystem and exits with an error on missing settings without any network call.
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
- **E10 Fee ceiling.** A goal whose simulated fee exceeds the configured maximum is skipped and retried on the next run. The default ceiling is set from section 9 measurements. Amended 2026-10-28 (W98): the keeper's signer reads the transaction's total fee before signing and refuses above the ceiling, logged as a skip; the default is 1 XLM (measured goal writes 0.001 to 0.27 XLM; the rent spike after the 0.3.0 upgrade 53 XLM).
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
  - the sum of all recorded balances and accrued fees equals the contract's token balance (W63);
  - every payout plus its fees and penalty equals the principal withdrawn;
  - no goal closes while anything is owed (L5);
  - at most one collection per period (P3);
  - skims never exceed the monthly cap (P13).
- **T4 Integration tests.** Spend & Save depositing into a real Target Savings contract (P15), using a real Stellar asset contract created in the test environment.
- **T5 TTL tests.** Touched entries are extended, and an archived open goal can be restored.
- **T6 Upgrade tests.**
  - Only the upgrader can upgrade, stored records remain readable after an upgrade, and `upgraded` is emitted with the new Wasm hash and the operator (C5).
  - These tests use the real compiled Wasm, so contracts are always built with `stellar contract build` before the tests run, in CI and locally. A repo script runs both in that order.
- **T7 SDK tests.** A fake RPC is injected through the stellar-sdk `server` option. The tests cover:
  - error mapping;
  - amount helpers;
  - local-time windows;
  - TRY_AGAIN_LATER retries;
  - a timeout returning pending without a second transaction.
- **T8 End-to-end tests in CI on a private local network.** Amended 2026-10-26 (W66, W67).
  - CI runs the `stellar/quickstart` fixed build `v678-b1525.1-latest`, pinned by its attested digest, with `docker run` and `--local --limits testnet --protocol-version 29 --enable core,rpc`, and waits for RPC health itself. The image's default local protocol is 28, so the version is set to match testnet. The official quickstart action is not used, because it pulls an unpinned action inside.
  - It creates throwaway accounts funded by the local Friendbot and issues a test token (a classic asset and its Stellar Asset Contract), with the Stellar CLI and a temporary config directory.
  - It deploys fresh instances with a 60-second minimum cadence and runs every user flow through the SDK in a separate Vitest suite, including a real collection, the closed-goal error-origin case, and an integrator account with no trustline (DoS.6). The keeper template container runs once (B8).
  - Withdrawal-window tests run only when the current UTC day is 1 to 28, and are skipped with a logged reason otherwise, since ledger time cannot be moved on a real network.
  - The `e2e` job becomes a required check after its first pass.
  - Nothing touches testnet, and no key outlives the run.
  - Multi-user scenario (W69, part 7c2), built on the same harness. Amended 2026-10-26:
    - about 10 users across 2 integrators, with one user enrolled with both, and about 60 goals in mixed states (due, already collected, closed, short of funds, missed), so paging must go past 50;
    - until 0.3.0, goal creations are sent one after another (W76). The W75 part adds a test where many users create goals in the same ledger and all succeed, and replaces the paging step with the new discovery. Amended 2026-10-26.
    - writes from several users sent at the same time;
    - after every step: the token balance equals all recorded balances plus accrued fees; each integrator accrued exactly its own fees and penalties; no user's action changed another user's records; each due goal was collected once;
    - cross-user attempts (a deposit to, or a withdrawal of, another user's goal) are refused with NotOwner, and a skim aimed at another user's goal falls back to the sender's balance.
- **T9 Testnet runs.** The owner deploys and runs scripted smoke flows with their own keys. Results are checked read-only.
- **T10 Budgets.**
  - Each contract function's resource use, measured in tests, stays under 25% of the per-transaction limits, and a 50-goal page fits within them.
  - On testnet, the owner's runs record read latency, end-to-end write latency, fees per function and TTL extension cost.
  - The compressed SDK bundle size is measured once, then CI fails on growth above 10%.
  - Keeper goals per minute are measured on the local network.
  - The 25% and 10% thresholds are judgments.
  - Speed and reliability targets (W70), our own judgments, since no published industry standard was found:
    - reads: the SDK adds no more than about 50 ms of its own on the local network, and reads are under 1 s at the 95th percentile on the public testnet RPC from the owner's location (measured on 2026-10-26: p50 426 ms, p95 943 ms; the RPC is the integrator's choice, G8);
    - writes: confirmed within 3 ledgers (about 15 s) at the 95th percentile on testnet, not counting the user's signing time;
    - reliability: no failures except the user's own (such as low funds or a goal not yet due), up to a measured and published breaking point.
  - Load and stress test (W71), on the local network only, whose `--limits testnet` matches testnet's resource limits. A separate workflow run by hand and weekly, so pull requests stay fast:
    - load: ramp concurrent users, each with its own account (10, 25, 50, 100), recording success rate, p50 and p95 confirmation time, TRY_AGAIN_LATER retries and transactions per ledger;
    - stress: keep ramping past normal levels until it degrades or fails, record the breaking point, and run the keeper sweep during the overload;
    - recovery: afterwards the token balance equals all recorded balances plus accrued fees, no goal was collected twice, the keeper catches up without double-collecting, and no transaction is left stuck. Every SDK transaction has a 300 s upper time bound, and Stellar's docs say a transaction submitted after its time bounds cannot enter the transaction set.
    - Never on the public testnet RPC, which Stellar's docs say is rate limited.
  - Testnet latency sample (W73): about 300 reads and 50 writes in the owner's smoke run, paced to respect the rate limit, with p50 and p95 against the W70 targets in the evidence document.
  - Resource limits are read live (Stellar docs: set by validator vote and changing over time). Testnet on 2026-10-26, protocol 29: 400,000,000 instructions per transaction and 580,000,000 per ledger; 200 entries read and 200 written per transaction; 2,000 contract transactions per ledger; 5 s target close. Mainnet limits are read live before any mainnet step.
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
  - npm's docs say a package must already exist before a trusted publisher can be configured. So the owner publishes `0.1.0` by hand, once. That one version has no provenance. Amended 2026-10-23 (W53).
  - The owner configures the trusted publisher only when the next release is ready to go from CI, because of the 2-day limit.
  - `package.json` `repository.url` is `git+https://github.com/Lokt-In/loktin-sdk.git`, with `directory` set to `packages/sdk`. npm requires an exact match for trusted publishing.
  - Trusted publishing needs npm 11.5.1 and Node 22.14.0 or later, so the release job runs on Node 24.
  - Releases from CI are staged, never published directly. The trusted publisher allows `npm stage publish` only. CI builds, checks and stages each version with provenance, and nothing goes live until the owner approves it with two-factor authentication. Once a CI release has worked, the package's publishing access is set to require two-factor authentication and disallow tokens. Amended 2026-10-24 (W60).
  - The package ships `src/` next to `dist/`, so its source maps resolve for integrators. Amended 2026-10-24 (W61).
- **V3 Release flow.** Amended 2026-10-24 (W62).
  - A separate `release-sdk.yml` workflow runs on a pushed `sdk-v<version>` tag. It refuses a tag that is not on `main` or does not match the package version.
  - It runs every Node check on Node 24.22.0 (bundling npm 11.19.1; staging needs npm 11.15.0), with no caching. Amended 2026-10-28 (W105): Node 24.22.1, the security release, before the 0.4.0 tag.
  - It stages the version, or skips staging when that version is already on npm (the hand-published `0.1.0`).
  - It creates a draft GitHub release from the version's changelog section, which the owner publishes after approving the staged version.
  - The owner's steps are in `docs/release.md`.
- **V4 Build verification.**
  - Release Wasm is built in GitHub Actions following SEP-55 (Draft): a `source_repo=github:Lokt-In/loktin-sdk` metadata entry in the Wasm plus a GitHub artifact attestation. GitHub docs: on Free, Pro and Team plans, attestations work only for public repositories, so this runs after the repo is public (constraint 9).
  - Loktin's testnet instances are deployed from exactly that Wasm.
  - If time runs short, the evidence records each Wasm hash and commit instead.
- **V5 Deploy runbook (owner).**
  - Create keys by alias: admin, fee-admin, pauser, upgrader, deployer, keeper. Fund them from Friendbot.
  - Deploy both contracts with: Circle testnet USDC, a 1-day minimum cadence, a 0% Loktin fee, and the roles assigned.
  - After every upload or upgrade, the owner extends each new code entry to the network's longest TTL with `stellar contract extend --wasm-hash <hash>`, paid by the deployer, so no user's call pays that rent (W93, 2026-10-28: the first call after the 0.3.0 upgrade paid 53.46 XLM to extend the Target Savings code).
  - Record the addresses in the SDK's testnet configuration through a pull request.
  - The reviewer then checks configuration, role holders and the Wasm hash against the attested build, read-only.
- **V6 Testnet smoke script.** A script runs every user flow through the SDK on testnet and writes every transaction hash to evidence files. The owner runs it with their own keys. Amended 2026-10-26 (W68), 2026-10-28 (W82 to W90, W92):
  - Form (W82): one TypeScript script, `packages/sdk/smoke/testnet-smoke.ts`, run with `node` on Node 24 (which runs TypeScript directly). It has its own tsconfig, covered by `npm run typecheck` and ESLint like the e2e folder, and uses the workspace build of the SDK. The evidence records the SDK version and git commit. It never runs in CI and is not in the npm package. Its pure helpers (percentiles, budget check) have unit tests.
  - Signing (W83): the signer passes each transaction to `stellar tx sign --quiet --sign-with-key <alias> --network-passphrase <passphrase>`, called directly, not through a shell. Secrets stay in the Stellar CLI keystore; the script never reads it and has no `signAuthEntry`, since every call is signed by its sender alone. Signing time is measured on its own.
  - Keys and funding (W84): the owner creates and funds `loktin-smoke-user-a`, `loktin-smoke-user-b`, `loktin-smoke-integrator-a` and `loktin-smoke-integrator-b` with Friendbot, adds a USDC trustline to all four (integrators need it to claim), and takes 20 USDC from Circle's faucet for each user. `LOKTIN_SMOKE_*` variables override the names. A read-only preflight checks XLM, trustlines and USDC balances, including the evidence-goal reserve, and stops before any write if anything is short.
  - Phases, run in this order:
    - `goals` (W87): the two evidence goals for the keeper. User A: 5% penalty, integrator A. User B: lock, integrator B. Both: target 5 USDC, 1 USDC daily deposits, deadline 7 days after creation, allowance approved at creation. An open matching goal is skipped, so a rerun is safe. They must exist by 31 October. Seven periods give two missed periods of slack; periods due before the keeper runs are recorded as missed, and no one collects them by hand. Amended 2026-10-28 (W94): the deadline was set from the local clock, 6 s short of start + 7 days, so the goals created on 28 October have 6 periods and one missed period of slack; the deadline gets a margin so later goals keep 7.
    - `run` (W85, W88): the flows, then the latency sample. Each user creates a penalty goal and a lock goal, deposits, and withdraws the penalty goal early. User A enrols in Spend & Save with integrator A (to the balance, withdrawal day 1) and with integrator B (into a goal), and makes a `payAndSave` to user B and a `saveForSpend`. Both integrators check and claim their Target Savings fees. Expected refusals are recorded by error name: Locked, NotOwner and OutsideWindow. Each user keeps 5 USDC in reserve for the evidence goals. Before any write it checks that both evidence goals are open, and stops if not. It can be run again after a stop (W92, 2026-10-28): it first closes every other open goal a stopped run left (a goal past its deadline, at its target or empty is withdrawn; a penalty goal is withdrawn early; a lock goal is filled to its target, then withdrawn) and updates an existing enrolment instead of enrolling again, recording each step.
    - `window` (W86): on 1 November UTC, withdraw both Spend & Save balances, claim the integrators' Spend & Save fees and close both enrolments.
  - Latency sample (W73, W88): 300 SDK reads one after another with a 200 ms gap, mixing the read functions, then 50 writes (0.01 USDC deposits into a spare goal, 25 per user). Write time runs from the call to the confirmed result, minus signing time. p50, p95 and maximum go against the W70 targets. Each write's fee comes from `getTransaction` (`feeCharged`), outside the sample.
  - Evidence files (W89): `evidence/evidence-goals.json`, `evidence/testnet-smoke.json` and `evidence/testnet-smoke-window.json`, each with the network, RPC URL, contract ids, SDK version and commit, UTC start and end, aliases with public addresses, and per step the label, function, actor, hash, ledger, fee, time and stellar.expert link, plus the expected refusals and the latency summary. Written after every step with `"complete": false` until the end. A PENDING result is recorded with its hash and the phase stops without resending. No secret is ever handled. The owner commits the files through a pull request, and the reviewer checks them against the chain.
  - Runbook (W90): a "Testnet smoke run" section in `docs/deploy.md` replaces the "Not yet covered" line.
- **V7 Evidence keeper.**
  - A scheduled GitHub Actions workflow in this repo runs the keeper template container hourly, at an off-peak minute. GitHub's shortest schedule interval is 5 minutes, and runs can be delayed or dropped at busy times.
  - The keeper key is a repository Actions secret holding only XLM.
  - Its hourly runs from 31 October also serve as a light soak test (W71).
  - Amended 2026-10-28 (W95, W99, W100): until 8b, the workflow `.github/workflows/evidence-keeper.yml` runs one keeper pass from the repo's own build instead of the container, at minute 17 of every hour and by hand (from 2026-10-28, W109: at minutes 7, 22, 37 and 52 of every hour, because no scheduled run fired in its first two hours; GitHub docs say scheduled runs can be delayed or dropped at busy times, and standard runners are free in public repositories); read-only permissions, actions pinned by hash, no overlap, 10-minute limit, no pull request trigger. The owner creates `loktin-keeper` (Friendbot, XLM only, no role) and sets `LOKTIN_KEEPER_SECRET` with `stellar keys secret loktin-keeper | gh secret set`, so the key is never shown. Only the step that runs the keeper sees the secret, after install and build; it writes it to a file only that step can read, passes the path, and deletes it. The workflow lists both smoke integrators and both smoke users. JSON log lines in the run logs (kept 90 days) and the deposit events on chain are the evidence; B11 compiles `docs/evidence.md` from them.
  - Amended 2026-10-29 (W110): each run pulls the base image by digest from Docker Hub, which limits anonymous pulls to 100 per 6 hours per address, shared on CI platforms. No change now: a refused pull fails only that pass. The runs are watched, and a fix (such as pulling the same digest from a mirror) comes if pull failures show.
  - Amended 2026-10-28 (W107): once 8b-2 merges, the workflow builds the image from `templates/keeper` each run and runs it as in E6. If 8b-2 is not merged by 1 November, it stays on the repo build (cut order item 3), decided at that check.
- **V8 Keeper template location.** It stays a folder in this repo, with "copy this folder" instructions. The evidence links to the folder. Amended 2026-10-28 (W104): the folder is `templates/keeper/`, a standalone npm project outside the root workspaces, with its own `package.json`, lockfile and `.npmrc` (7-day minimum release age, no install scripts, exact versions), depending on `@loktin/sdk` 0.4.0 exactly and `@stellar/stellar-sdk` 17.2.1. Its lockfile is made in two steps, so every package but `@loktin/sdk` passes the 7-day rule. It has its own CI job: install, lint, typecheck, tests and the image checks.
- **V9 Docs.**
  - An SDK section on docs.loktin.xyz (repo `Lokt-In/loktin-docs`):
    - quickstart;
    - a guide per primitive;
    - keeper guide;
    - security and trust page (upgrade authority, no yield, fees);
    - API reference built from the code by TypeDoc.
  - The current yield wording on that site ("Plan. Lock In. Earn." and yield through Blend) is removed in the same release.
  - The owner deploys the docs.
  - Amended 2026-10-30 (W118 to W130). This replaces the removal of the yield wording above.
    - Two sections (W118). The Loktin app's pages stay as they are, at the same addresses, yield and Blend included: the app runs on testnet with no real money, on its own earlier contracts from the `loktin` repo, and does not use the SDK yet. Only the slogan changes, from "Plan. Lock In. Earn." to "Plan. Lock In. Save.", in the home page hero, the site description and `og:description`. The rest of the site is revamped later, outside this sprint.
    - The SDK section (W119) lives under `/sdk/`: overview, quickstart, a Target Savings guide, a Spend & Save guide, a keeper guide, a security and trust page (upgrade authority, pause, roles, fees and penalties, no yield and the yield slot switched off), testnet contracts, and the API reference under `/sdk/api/`. The overview says in one line that the SDK has its own contracts, separate from the app's for now. An "SDK" link goes in the top bar. The SDK gets its own sidebar keyed `/sdk/`; the app's sidebar is keyed `/` and does not change (VitePress 1.6.4 picks the most specific key). Evidence links (V12) point at `/sdk/` pages, never at the home page.
    - API reference (W120): TypeDoc 0.28.20 with typedoc-plugin-markdown 4.14.1 and typedoc-vitepress-theme 1.1.4, run in the docs repo before the VitePress build, on the four entry points of the published `@loktin/sdk` (`dist/index.d.ts`, `target-savings`, `spend-save`, `keeper`), pinned exactly, with `excludeExternals: false` because the package sits in `node_modules`. The generated pages and sidebar are not committed.
    - Code samples (W121) are `.ts` files in `snippets/`, pulled into pages with `<<< @/snippets/<file>#<region>` and type-checked against the pinned SDK as part of the build.
    - The SDK's doc comments carry plan codes (77 in 36 of the 80 generated pages on 0.5.0). B11 removes them from the SDK source before 1.0.0, and the docs move to 1.0.0 in a small docs PR then (W122).
    - Install (W123): VitePress stays 1.6.4 (2.0 is alpha) and Vue 3.5.33. The docs repo gets an `.npmrc` like the keeper template's (7-day minimum release age, no install scripts, exact versions), exact versions in `package.json`, and `npm ci` as Vercel's install command. `@loktin/sdk` is added in two steps, as in the template.
    - `"cleanUrls": true` in `vercel.json` (W124). Without it every page but the home page returns 404 on a direct load, as on 2026-10-30.
    - Staging (W125) is the Vercel preview of each pull request, behind Vercel Authentication; the reviewer checks it read-only through the Vercel connector. Vercel deploys `main` to production on every push, so the owner's merge is the deploy. After it, the reviewer checks production read-only.
    - CI (W126): one workflow in the docs repo runs `npm ci` and the full build (TypeDoc, snippet type-check, VitePress build, which fails on dead links). After 9a merges, the owner adds a ruleset like this repo's: pull request required, the build check must pass.
    - A second builder session (W127), opened in `~/personal-projects/loktin-docs`, with the same repo rules. It may read this repo but never writes to it. Its facts come from the published package, its README and `docs/architecture.md` on `main`.
    - The "Edit on GitHub" link points at `Lokt-In/loktin-docs` (W130).
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
| B5 | Repo goes public. Release Wasm build with SEP-55 attestation, deploy and smoke scripts. Owner deploys to testnet; reviewer verifies | 28 Oct |
| B6 | SDK core and both primitive modules (K1 to K12) with tests T7, in three parts, each checked and merged on its own: 6a core, 6b the two modules and helpers, 6c the npm release workflow and package metadata. Preview `0.1.0` is published, on the owner's go-ahead. Amended 2026-10-23 (W54) | 30 Oct |
| B7 | In four parts. 7a: accrued fees in both contracts (W63) with tests and an upgrade decision note. Owner releases `contracts-v0.2.0` and upgrades the testnet contracts in place (W64). 7b: SDK `accruedFees` and `claimFees`, released as 0.2.0 through the staged CI flow (W65). 7c: local-network end-to-end tests in CI (T8). 7c2: the multi-user scenario (W69), with creations sent one after another for now (W76). 7e: goal ids per owner (W75) in Target Savings 0.3.0 with its decision note and storage-compatibility test; owner releases `contracts-v0.3.0` and upgrades in place; SDK 0.3.0 without `nextId` and `openGoals`; the concurrent-creation test. 7d: testnet smoke script with two users and two integrators, plus the latency sample; owner runs it and creates the evidence goals (V6, W73, W82 to W90), after 7e. Amended 2026-10-26, 2026-10-28 | 1 Nov |
| B8 | Keeper client and template; hourly evidence keeper. Owner adds the keeper secret. Keeper at scale with the sizing table (E3, W72), first to keep if time runs short. The hourly evidence keeper comes first and must be collecting before 31 Oct 16:49 UTC, so the evidence goals' periods 2 to 6 reach their target (W94). In three parts (W95): 8a, the keeper core in `@loktin/sdk/keeper`, a one-pass runner and the hourly evidence workflow from the repo build, with unit tests and one e2e file (W101), the W93 runbook step and the W94 deadline margin (W102); 8b in two steps (W103): 8b-1, SDK 0.4.0 with `@loktin/sdk/keeper` (version, CHANGELOG, README keeper section, release workflow on Node 24.22.1), released by the owner; 8b-2, the standalone template in `templates/keeper/` (W104), its container (E6, W105, W106), scheduler examples and checks (E5, W108), its docs and CI job, and the evidence workflow switched to the image (W107); 8c in two steps (W115): 8c-1, batched reads and channel accounts in `@loktin/sdk/keeper`, the local sizing script and its results, the owner-wide allowance (W116), released by the owner as SDK 0.5.0; 8c-2, the template on 0.5.0 (two-step lockfile), the runner reading one key per line, and the sizing table in the template README, then a hand-started evidence run checked after the merge. The keeper's own store and `extend` are dropped for the sprint (W111). Amended 2026-10-26, 2026-10-28, 2026-10-29 | 8a 29 Oct, 8b 29 Oct, 8c 31 Oct |
| B9 | Docs in `loktin-docs` (second builder session). In two parts (W128), each checked and merged on its own: 9a, the SDK section's setup (slogan, top bar link, `/sdk/` sidebar, `cleanUrls`, install rules, TypeDoc API reference, snippet type-check, CI, edit link) with a short overview page; 9b, the SDK pages (quickstart, both guides, keeper guide, security and trust, testnet contracts). Before 9a, a docs-only part in this repo records the V9 amendment here (W129). Amended 2026-10-30 | 2 Nov |
| B10 | Reference app repo and demo (second builder session) | 3 Nov |
| B11 | Measurements (T10) with the speed targets, the load and stress test and its report (W70, W71), mutation testing (T12), evidence document, walkthrough draft, `1.0.0` release. Amended 2026-10-26 | 4 Nov |
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
