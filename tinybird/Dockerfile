FROM python:3.14-slim@sha256:6a27522252aef8432841f224d9baaa6e9fce07b07584154fa0b9a96603af7456

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/tinybird

# Install Tinybird using the standard installation script
COPY handleLogin.sh /usr/local/bin/tinybird-login
COPY getTokens.sh /usr/local/bin/get-tokens
COPY tb-wrapper /usr/local/bin/tb-wrapper

RUN curl https://tinybird.co | sh

ENV PATH="/root/.local/bin:$PATH"
