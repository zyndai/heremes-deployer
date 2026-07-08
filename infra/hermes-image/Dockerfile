# Hermes gateway image, patched for self-hosting.
#
# Upstream nousresearch/hermes-agent:latest sends the Telegram onboarding
# request to the Nous setup service with no User-Agent; that service's
# Cloudflare Worker returns 403 to the default urllib UA, which Hermes surfaces
# as a 502 "Telegram setup service returned an error." This overlay adds a
# browser User-Agent so the QR onboarding flow works. See patch-telegram-ua.py.
#
# Build:  docker build -t <registry>/hermes-agent:0.16.0-ua infra/hermes-image
# Pin it: set HERMES_IMAGE to the tag you push.
ARG HERMES_BASE=nousresearch/hermes-agent:latest
FROM ${HERMES_BASE}

COPY patch-telegram-ua.py /tmp/patch-telegram-ua.py
COPY patch-empty-assistant.py /tmp/patch-empty-assistant.py
# Run as root for the in-place edit; the base image's own entrypoint drops to
# HERMES_UID at runtime, so this doesn't change the runtime user.
USER root
RUN python3 /tmp/patch-telegram-ua.py /opt/hermes/hermes_cli/web_server.py \
    && python3 /tmp/patch-empty-assistant.py /opt/hermes/agent/agent_runtime_helpers.py \
    && rm -f /tmp/patch-telegram-ua.py /tmp/patch-empty-assistant.py
