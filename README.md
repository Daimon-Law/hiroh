# Hiroh

Self-hosted, end-to-end encrypted file and text sharing between your devices,
in the browser.

<p align="center">
  <img src="docs/images/hero.png" alt="Hiroh on a laptop, showing paired devices, and on a phone, showing a conversation with two files received" width="900">
</p>

<p align="center">
  <img src="docs/images/phones.png" alt="Pairing by QR code, accepting files from another device, and the dark theme" width="720"><br>
  <sub>Pair with a QR code · Accept or decline every file · Light and dark themes</sub>
</p>

## Requirements

- Linux with Docker and Docker Compose v2. The first build needs about 1.5 GB
  of RAM and 10 GB of free disk.
- A hostname served over HTTPS, for example `hiroh.example.com`. Only port 443
  is needed; there are no UDP ports to open.

## Run it

```sh
git clone https://github.com/Daimon-Law/hiroh.git
cd hiroh
cp .env.example .env
```

Edit `.env`:

```sh
HIROH_SITE_ADDRESS=hiroh.example.com
HIROH_PUBLIC_URL=https://hiroh.example.com/
HIROH_RELAY_TOKENS=alice:<token>,bob:<token>
```

Make a token for each person with `openssl rand -hex 24`. Then:

```sh
docker compose up -d --build
```

The first build takes several minutes. Caddy gets a certificate for the
hostname on first start. Open `https://hiroh.example.com`.

### Behind your own reverse proxy or tunnel

Set these instead, and point your proxy at `http://<docker-host>:8080` for the
whole hostname:

```sh
HIROH_SITE_ADDRESS=:80
HIROH_HTTP_PORT=8080
HIROH_PUBLIC_URL=https://hiroh.example.com/
```

The proxy must pass WebSocket upgrades and set `X-Forwarded-For`.

### With an existing Traefik

Set `HIROH_HOST`, `TRAEFIK_NETWORK` and `TRAEFIK_ENTRYPOINT` in `.env`, then:

```sh
docker compose -f deploy/traefik/compose.yaml --env-file .env up -d --build
```

## Settings

All settings go in `.env`. [`.env.example`](.env.example) lists them with
comments.

| Variable | Purpose |
| --- | --- |
| `HIROH_SITE_ADDRESS` | Your hostname, or `:80` behind another proxy. |
| `HIROH_PUBLIC_URL` | The HTTPS address people open, with a trailing slash. |
| `HIROH_HTTP_PORT`, `HIROH_HTTPS_PORT` | Host ports for the bundled Caddy. |
| `HIROH_RELAY_TOKENS` | `label:token` pairs, comma separated, one per person. |
| `HIROH_MAX_GUEST_HOURS` | Longest guest access a member can grant. Default 168. |
| `HIROH_DORMANT_HOURS` | Devices unseen this long must register again. Default 24. |
| `HIROH_CLIENT_IP_HEADERS` | Headers that carry the visitor's address. Default `x-forwarded-for`. |
| `RUST_LOG` | Relay log level. |

## Giving people access

Add a `label:token` pair to `HIROH_RELAY_TOKENS` and run `docker compose up -d`.
The person opens your Hiroh address, goes to **Settings**, chooses **Private
relay**, pastes the token, presses **Test**, then **Save**. To revoke someone,
remove their pair and run `docker compose up -d` again.

## Updating

```sh
git pull
docker compose up -d --build
```

## Licence

MIT, copyright DexWorks Pty Ltd. See [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md).
