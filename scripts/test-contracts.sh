#!/usr/bin/env bash
# Builds the contracts with the Stellar CLI, then runs every Rust test.
# The upgrade tests load the built Wasm, so the build must come first.
set -euo pipefail

cd "$(dirname "$0")/.."

stellar contract build
cargo test --workspace --locked
