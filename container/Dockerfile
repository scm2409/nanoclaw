# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

# Pinned uv release, used to install the Python MCP CLIs further down. It has to
# come in as its own stage: `COPY --from=` does not expand build args inside an
# image reference, only a stage name.
ARG UV_VERSION=0.11.32
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uvbin

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin versions for reproducibility. Bump deliberately — unpinned installs mean
# every rebuild silently picks up the latest and can break in lockstep across
# all users. The global Node CLIs (claude-code, agent-browser, vercel) are
# pinned in cli-tools.json so a skill can add one with a json-merge; Bun (the
# runtime) is pinned here because it installs from a different source.
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
        git \
        tini \
        unzip \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Chromium path for agent-browser / Playwright consumers
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Belt-and-braces: prevent Playwright's postinstall from downloading its own
# ~300MB Chromium. We've already installed the system one above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Global Node CLIs the agent invokes at runtime live in cli-tools.json so a
# skill can add one with a json-merge instead of editing this Dockerfile.
# install-cli-tools.sh installs each via pnpm (pinned), writing the per-tool
# only-built-dependencies opt-ins it reads from the manifest.
COPY cli-tools.json install-cli-tools.sh /tmp/
RUN --mount=type=cache,target=/root/.cache/pnpm \
    sh /tmp/install-cli-tools.sh /tmp/cli-tools.json

# ---- Python CLIs (uv) --------------------------------------------------------
# Some MCP servers the agent spawns are Python, not Node — cli-tools.json only
# covers pnpm globals. uv ships its own Python, so no apt python3 and no second
# system package manager in PATH.
#
# Both pins are deliberate: PyPI is outside pnpm's minimumReleaseAge gate, so
# versions are chosen by hand from a release at least a week old.
#
# UV_TOOL_DIR / UV_PYTHON_INSTALL_DIR must be redirected: uv defaults to
# ~/.local/share/uv, which is /root/... at build time and unreadable by the
# non-root `node` user the container actually runs as.
ARG NEXTCLOUD_MCP_VERSION=0.145.0
COPY --from=uvbin /uv /usr/local/bin/uv
ENV UV_TOOL_DIR=/opt/uv/tools \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    UV_TOOL_BIN_DIR=/usr/local/bin
RUN --mount=type=cache,target=/root/.cache/uv \
    uv tool install --python 3.12 "nextcloud-mcp-server==${NEXTCLOUD_MCP_VERSION}" && \
    chmod -R a+rX /opt/uv

# nextcloud-mcp-server hands httpx a transport it built itself, and an explicit
# transport ignores HTTPS_PROXY — those requests skip the OneCLI gateway and
# arrive upstream with the credential placeholder (401). Installed as
# sitecustomize.py so it loads before any server code.
COPY httpx-env-proxy-shim.py /tmp/httpx-env-proxy-shim.py
RUN cp /tmp/httpx-env-proxy-shim.py \
       "$(ls -d /opt/uv/tools/nextcloud-mcp-server/lib/python3.*/site-packages)/sitecustomize.py" && \
    rm /tmp/httpx-env-proxy-shim.py

# Martin's fork of mcp-mealie (github.com/scm2409/mcp-mealie), which adds a
# restricted mode over upstream mgummich/mcp-mealie. Pinned to a commit, not
# a tag or @main: restricted mode is unreleased on the fork (__version__ is
# still 0.3.1, no git tag exists), and an unpinned ref would let a routine
# image rebuild silently change the tool surface — see
# src/mealie-mcp-pin.test.ts, which fails the build if this ever points at a
# branch name instead of a commit.
ARG MEALIE_MCP_REF=80e9166
RUN --mount=type=cache,target=/root/.cache/uv \
    uv tool install --python 3.12 \
      "git+https://github.com/scm2409/mcp-mealie@${MEALIE_MCP_REF}" && \
    chmod -R a+rX /opt/uv

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
