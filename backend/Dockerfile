# syntax=docker/dockerfile:1.6
# -----------------------------------------------------------------------------
# Stage 1: builder — install Python dependencies and Playwright browsers.
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Build-time libraries only; runtime libs are added separately in the final stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      wget \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml /build/pyproject.toml
COPY app /build/app

RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install .

# Install Playwright browsers into /opt/pw-browsers so we can copy them forward.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN /opt/venv/bin/python -m playwright install chromium


# -----------------------------------------------------------------------------
# Stage 2: runtime — minimal dependencies, non-root user, virtualenv from builder.
# -----------------------------------------------------------------------------
FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

WORKDIR /app

# Runtime-only system libraries needed by Chromium + sound + font rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 \
      libnspr4 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libdbus-1-3 \
      libxkbcommon0 \
      libatspi2.0-0 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libgbm1 \
      libasound2 \
      libpango-1.0-0 \
      libcairo2 \
      libx11-6 \
      libxcb1 \
      libxext6 \
      libxshmfence1 \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Copy the virtualenv + Playwright browsers from the builder stage.
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/pw-browsers /opt/pw-browsers

# Application code.
COPY app /app/app

# Non-root user for the process.
RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid 1000 --home /app --shell /usr/sbin/nologin app \
    && mkdir -p /app/data \
    && chown -R app:app /app /opt/venv /opt/pw-browsers

USER app

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD curl -fsS http://127.0.0.1:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
