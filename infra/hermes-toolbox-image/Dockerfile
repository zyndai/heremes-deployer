# Ephemeral dev-shell image for the agent terminal feature (shell.ts). One of
# these is spun up per terminal WS session, bind-mounted at the agent's own
# /opt/data (same volume the gateway container uses), then torn down when the
# session closes. Kept entirely separate from the Hermes gateway image
# (infra/hermes-image) on purpose: this gives owners a real dev toolset
# (editor, pip, build tools) without ever touching the image that actually
# runs their agent.
#
# Build:  docker build -t <registry>/hermes-toolbox:<tag> infra/hermes-toolbox-image
# Pin it: set TOOLBOX_IMAGE on the worker to the tag you push.
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    ca-certificates \
    openssh-client \
    vim \
    nano \
    less \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    nodejs \
    npm \
    unzip \
    jq \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Matches HERMES_UID/HERMES_GID (config.ts default 10000) — the worker execs
# in as this uid:gid, never root. A real passwd/home entry avoids tools that
# misbehave for an unmapped uid (git identity lookups, $HOME-dependent
# rc files, some npm/pip cache path defaults).
RUN groupadd -g 10000 hermes \
    && useradd -u 10000 -g 10000 -M -d /opt/data -s /bin/bash hermes

# No CMD/ENTRYPOINT: the worker always passes an explicit interactive Cmd
# (bash -i, see shell.ts) as the container's PID 1.
