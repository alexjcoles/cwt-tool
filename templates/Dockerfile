# Generic dev container for cwt worktrees.
# This is a starting point — when wired to a real project (e.g. PatentSafe),
# replace this with the project's existing devcontainer Dockerfile.
FROM ruby:3.3-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV BUNDLE_PATH=/usr/local/bundle
ENV CARGO_HOME=/usr/local/cargo

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      gnupg \
      libpq-dev \
      libyaml-dev \
      pkg-config \
      postgresql-client \
      tmux \
      unzip \
      vim \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 for esbuild/vite
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Bun for the channel MCP server (M2)
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# Rust (some Ruby gems and the channel server may need it)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path \
    && ln -s /root/.cargo/bin/cargo /usr/local/bin/cargo \
    && ln -s /root/.cargo/bin/rustc /usr/local/bin/rustc

WORKDIR /workspace

# tmux config so attach is consistent
RUN echo "set -g mouse on" > /root/.tmux.conf \
    && echo "set -g history-limit 50000" >> /root/.tmux.conf

CMD ["sleep", "infinity"]
