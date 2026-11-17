# Broker image: holds all secrets, proxies LLM calls, runs the paid tools. See compose.yaml.
FROM node:24-trixie-slim

# pdftoppm renders a PDF page for describe_figure.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY src/shared ./src/shared
COPY src/broker ./src/broker
COPY config ./config

USER node
CMD ["node", "src/broker/server.ts"]
