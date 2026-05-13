# syntax=docker/dockerfile:1.6
# -----------------------------------------------------------------------------
# Stage 1: builder — install JS deps and produce a production-optimised bundle.
# -----------------------------------------------------------------------------
FROM node:20-alpine AS build

WORKDIR /app

ARG VITE_API_BASE=http://localhost:8000
ENV VITE_API_BASE=$VITE_API_BASE

# Install deps first so the layer is cacheable when package.json is unchanged.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi

COPY . /app
RUN npm run build


# -----------------------------------------------------------------------------
# Stage 2: runtime — serve static assets from nginx as the unprivileged user.
# -----------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# Remove the default vhost and install our own config.
COPY --from=build /app/dist /usr/share/nginx/html
RUN rm -f /etc/nginx/conf.d/default.conf
COPY <<'NGINXCONF' /etc/nginx/conf.d/default.conf
server {
    listen 80 default_server;
    server_name _;

    # SPA fallback.
    root /usr/share/nginx/html;
    index index.html;

    # Long-lived caching for hashed assets, no-store for the HTML entry.
    location = /index.html {
        add_header Cache-Control "no-store, must-revalidate" always;
    }
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Minimal security headers for static content; API CORS is enforced server-side.
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
NGINXCONF

EXPOSE 80

HEALTHCHECK --interval=20s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/index.html >/dev/null 2>&1 || exit 1
