#!/bin/sh
# Builds Hiroh's WebAssembly module (crates/hiroh-wasm) and writes the
# JavaScript bindings to web/src/wasm/pkg.
# Needs Rust with the wasm32-unknown-unknown target and wasm-bindgen-cli
# 0.2.126 (cargo install wasm-bindgen-cli --version 0.2.126 --locked).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
target_dir=${CARGO_TARGET_DIR:-$root/target}
cargo build --release --target wasm32-unknown-unknown \
	--manifest-path "$root/crates/hiroh-wasm/Cargo.toml" --target-dir "$target_dir"
wasm-bindgen --target web --out-name hiroh_wasm \
	--out-dir "$root/web/src/wasm/pkg" \
	"$target_dir/wasm32-unknown-unknown/release/hiroh_wasm.wasm"
