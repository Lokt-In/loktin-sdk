# Loktin SDK: Architecture

Status: draft, being planned step by step. Only agreed decisions are written here.
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
9. **Publishing.** The repo stays private and nothing is published to npm until the owner says so.
10. **First integrator.** Loktin's own reference app.

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
- **G7 Runtimes.** The minimum is Node 22.12, the minimum that `@stellar/stellar-sdk` 17.3.0 itself requires. CI tests Node 22, 24 and 26. Browser targets are set in section 7.
- **G8 Performance.**
  - No Loktin server sits in any request path.
  - A read costs one RPC call. A write costs simulate, sign, send and confirm, and nothing more.
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
  - the owner creates every key and runs every deploy;
  - local tool settings stay in `.git/info/exclude`, never in `.gitignore`.

## 2. Repo, tooling and supply chain

Agreed 2026-10-22.

### 2.1 Layout

```
loktin-sdk/
├─ contracts/            Rust, one crate per contract (target-savings, spend-save)
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
| Rust | Pinned in `rust-toolchain.toml` to 1.99.1 with the `wasm32v1-none` target. The soroban-sdk version is chosen in section 6. `Cargo.lock` is committed and every cargo command in CI uses `--locked`. |
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

Not yet planned.

## 5. Revenue and fees

Not yet planned.

## 6. Contract architecture

Not yet planned.

## 7. SDK architecture

Not yet planned.

## 8. Keeper tooling

Not yet planned.

## 9. Testing and performance

Not yet planned.

## 10. Release, docs and evidence

Not yet planned.

## 11. Build order

Not yet planned.
