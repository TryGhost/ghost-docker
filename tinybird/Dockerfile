FROM python:3.13-slim@sha256:0222b795db95bf7412cede36ab46a266cfb31f632e64051aac9806dabf840a61

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
