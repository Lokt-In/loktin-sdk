# Loktin SDK

A headless TypeScript package that lets any Stellar wallet or remittance team add two savings primitives to their own product, with their own interface and their own signing flow:

- **Spend & Save**: skims a share of each spend in the host app into savings that the user can reach once a month.
- **Target Savings**: saving toward a goal with scheduled or manual deposits.

It also includes integrator-owned keeper tooling: a keeper client in the SDK and a deployable keeper template that an integrating team runs on its own infrastructure.

Status: in development, testnet only.

Shared error codes: [docs/errors.md](docs/errors.md)
