# Patched Hermes image

The image every agent container runs (`HERMES_IMAGE`). It is the upstream
`nousresearch/hermes-agent` with one fix applied.

## Why we patch

Hermes 0.16.0 builds the Telegram onboarding request to the Nous setup service
(`https://setup.hermes-agent.nousresearch.com/v1/telegram/pairings`) with no
`User-Agent` header. urllib then sends the default `Python-urllib/<ver>`, which
the Nous Cloudflare Worker blocks with **HTTP 403**. `web_server.py` maps that to
a **502 "Telegram setup service returned an error."** — so the dashboard's
**Set up with QR** button fails on every self-hosted container.

`patch-telegram-ua.py` adds a browser `User-Agent` to the two header dicts in
`web_server.py` that call external services via urllib. Verified: the onboarding
call returns **201** after the patch.

This is an upstream bug. Drop the patch once a Hermes release sets its own UA on
that request (the patch script fails loudly if the anchor line disappears, so a
version bump won't silently ship an unpatched image).

## Build & push

```bash
# from repo root
docker build -t ghcr.io/your-org/hermes:0.16.0-ua infra/hermes-image
docker push  ghcr.io/your-org/hermes:0.16.0-ua
```

Pin a different upstream base with `--build-arg`:

```bash
docker build \
  --build-arg HERMES_BASE=nousresearch/hermes-agent:0.16.0 \
  -t ghcr.io/your-org/hermes:0.16.0-ua infra/hermes-image
```

Then set `HERMES_IMAGE` (in `/etc/hermes-deployer/worker.env`) to the tag you
pushed and redeploy agents.
