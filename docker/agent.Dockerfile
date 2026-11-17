# Agent image: OpenCode in a sandbox with tools to read any common document format.
# Build with: docreader build (it resolves and pins the latest OpenCode version).
FROM node:24-trixie-slim

ARG OPENCODE_VERSION
RUN test -n "$OPENCODE_VERSION" || (echo "OPENCODE_VERSION build arg is required" && exit 1)

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl bash coreutils grep sed gawk jq file unzip tini \
      python3 python3-venv poppler-utils mupdf-tools \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa \
 && rm -rf /var/lib/apt/lists/*

# Python libraries the agent can use to open documents. It chooses what to use.
RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir \
      duckdb==1.4.1 openpyxl==3.1.5 python-docx==1.2.0 python-pptx==1.0.2 \
      pandas==2.3.3 numpy==2.3.4 xlrd==2.0.2 pypdf==6.1.1 pdfplumber==0.11.7 pymupdf==1.26.5 \
      pillow==12.0.0 lxml==6.0.2
ENV PATH=/opt/py/bin:$PATH

# OpenCode, pinned to the version the host resolved at build time.
RUN curl -fsSL https://opencode.ai/v2/install -o /tmp/install-opencode \
 && HOME=/opt/opencode bash /tmp/install-opencode --version "$OPENCODE_VERSION" \
 && install -m 0755 /opt/opencode/.opencode/bin/opencode /usr/local/bin/opencode \
 && rm -rf /opt/opencode /tmp/install-opencode

# The entrypoint uses only Node's standard library: no npm install.
WORKDIR /app
COPY src/shared ./src/shared
COPY src/agent ./src/agent

# Containers run as the host UID (src/server/docker.ts), so no path may depend on one user.
# OpenCode data: $XDG_DATA_HOME/opencode = AGENT_PATHS.opencodeData in src/shared/constants.ts.
RUN mkdir -p /var/lib/docreader/opencode && chmod -R 777 /var/lib/docreader && chmod 755 /home/node
USER node
ENV HOME=/home/node \
    XDG_DATA_HOME=/var/lib/docreader \
    XDG_CONFIG_HOME=/tmp/xdg/config \
    XDG_CACHE_HOME=/tmp/xdg/cache \
    XDG_STATE_HOME=/tmp/xdg/state \
    TMPDIR=/tmp \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true

ENTRYPOINT ["tini", "--", "node", "/app/src/agent/entrypoint.ts"]
