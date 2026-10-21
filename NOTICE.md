# Notice

Hiroh is copyright (c) 2026 DexWorks Pty Ltd and licensed under the MIT
licence, see [LICENSE](LICENSE). All code in this repository was written for
Hiroh.

## Third-party components

Hiroh is built on these libraries, each under its own licence:

| Component | Use in Hiroh | Licence |
| --- | --- | --- |
| [iroh](https://github.com/n0-computer/iroh) by n0 | Encrypted connections (QUIC, TLS 1.3, Ed25519 keys) and the relay | MIT OR Apache-2.0 |
| [iroh-blobs](https://github.com/n0-computer/iroh-blobs) by n0 | File transfer with BLAKE3 verification | MIT OR Apache-2.0 |
| [iroh-gossip](https://github.com/n0-computer/iroh-gossip) by n0 | Messaging between paired devices | MIT OR Apache-2.0 |
| [iroh-relay](https://github.com/n0-computer/iroh) by n0 | The relay server image used by `deploy/` | MIT OR Apache-2.0 |
| [iroh-tickets](https://github.com/n0-computer/iroh) by n0 | Ticket encoding | MIT OR Apache-2.0 |

`crates/hiroh-wasm/src/chat.rs` is based on n0's browser-chat example,
https://github.com/n0-computer/iroh-examples, licensed MIT OR Apache-2.0.

The other Rust and npm packages are listed in `crates/hiroh-wasm/Cargo.toml` and
`web/package.json`; each is under its own licence. The Docker images use
Caddy (Apache-2.0), nginx (BSD-2-Clause) and Node.js (MIT).
