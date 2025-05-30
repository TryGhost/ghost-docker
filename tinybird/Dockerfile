FROM python:3.13-slim

# Install dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/tinybird

# Install Tinybird using the standard installation script
RUN curl https://tinybird.co | sh

ENV PATH="/root/.local/bin:$PATH"
