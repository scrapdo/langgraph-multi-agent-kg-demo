# Security

The Brain is designed for **local, single-operator** use on a
trusted workstation. It is not hardened for public deployment. This document
lists the threat model assumptions, the controls that are in place, and how to
report issues.

## Scope & threat model

**In scope**
- Local desktop operator running the stack on macOS via the Electron launcher.
- Docker Desktop running containers on the loopback interface only.
- macOS host bridge controlling native apps (Word, Finder, browser) on the same
  workstation.

**Out of scope**
- Multi-tenant SaaS deployment.
- Unattended / public-network deployment with anonymous callers.
- Kernel, hypervisor, or Docker engine vulnerabilities.
- Provider-side security of OpenAI, Anthropic, Zep, ElevenLabs, etc.

The primary adversary we defend against is **any other process on the same Mac
that is not the operator** — including browser tabs on unrelated sites,
Spotlight crawlers, backup agents, and other users of a shared machine.

## Controls in place

### Secrets
- API keys and DB passwords live in `~/.config/kg-multi-agent/secrets.env`
  (chmod 600), **not** in the project tree. The project `.env` holds only
  non-sensitive configuration (model IDs, base URLs, ports).
- `.metadata_never_index` disables Spotlight indexing on the backups folder.
- `.gitignore` excludes `.env*`, `*secrets*`, `*.pem`, `*.key`, and editor
  sidecar files. A `gitleaks` step runs on every CI build.
- `~/.config/kg-multi-agent/` is chmod 700.

### Network surface
- `docker-compose.yml` binds every exposed port (API, frontend, Neo4j,
  Postgres, Redis) to `127.0.0.1` only. Nothing is reachable from the LAN.
- The Vite dev server binds to `127.0.0.1:5173`.
- The Electron main window restricts navigation to loopback origins; external
  links open in the system browser.
- A strict Content-Security-Policy is applied to every page load inside
  Electron, locking connect-src and script-src to loopback plus a short
  allowlist.

### API authentication & authorization
- The FastAPI app supports a bearer-token gate (`API_BEARER_TOKEN`) that
  protects every non-open route. `/health`, `/docs`, `/openapi.json`, the
  public scheduler slugs, and the Google OAuth callback are intentionally
  open.
- CORS is restricted to the origins listed in `ALLOWED_ORIGINS`
  (default: `http://localhost:5173,http://127.0.0.1:5173`).
- Every request gets an `X-Request-ID` correlation header, logged as JSON
  alongside method, path, status, latency, and client IP.

### Host bridge (macOS)
- Refuses to start without `HOST_AUTOMATION_TOKEN` — no silent unauthenticated
  fallback.
- Binds to `127.0.0.1` only.
- Paths are validated against `HOST_EXPORTS_ROOT` / `HOST_EXTRA_ROOTS`, and
  rejected if they contain `"`, `\`, `;`, newlines, or control characters.
- AppleScript is invoked via `osascript -e 'on run argv'` with the path passed
  as an `argv` parameter, so crafted paths cannot escape the string literal
  and run arbitrary AppleScript.
- Browser / app / URL inputs are pattern-validated and reject control chars
  and non-http(s) schemes.

### Database credentials
- Docker compose refuses to start unless `NEO4J_PASSWORD` and
  `POSTGRES_PASSWORD` are set in the environment (no `password`/`postgres`
  defaults in the compose file).

### Container posture
- Backend Dockerfile is multi-stage; the final image runs as an unprivileged
  `app` user (uid 1000) with a `HEALTHCHECK` for the uvicorn port.
- Frontend Dockerfile emits a minimal nginx image with `X-Content-Type-Options`,
  `X-Frame-Options`, and `Referrer-Policy` headers, plus healthcheck.

## Live side effects

The system can send SMS (Twilio/Telnyx), email (SendGrid), post to social
(X, LinkedIn, Instagram via webhook), and launch native macOS apps. These are
all opt-in:

- `SIDE_EFFECT_DEFAULT_MODE=simulation` is the default — runs do not touch
  external services until a user explicitly opts into `live` mode for a
  specific run.
- Live tools are gated further via `SIDE_EFFECT_LIVE_TOOLS_CSV`.
- Operator-approval cards surface in the inbox for every live action.

## Reporting a vulnerability

This is a personal project. If you believe you have found a security issue:

1. **Do not** open a public GitHub issue with exploit detail.
2. Email the repository owner directly with the subject line
   `SECURITY: <summary>`, describing the issue, impact, and a minimal
   reproduction.
3. Give 14 days for a fix before any public disclosure.

## Hygiene checklist before deploying anywhere other than your own Mac

- [ ] Set `API_BEARER_TOKEN` to a 32+ char random value.
- [ ] Set `HOST_AUTOMATION_TOKEN` likewise, or disable the host bridge.
- [ ] Replace `NEO4J_PASSWORD` and `POSTGRES_PASSWORD` with strong values.
- [ ] Tighten `ALLOWED_ORIGINS` to your actual domain.
- [ ] Put the API behind a reverse proxy (Nginx / Traefik) that terminates
      TLS and rate-limits `/runs`, `/secretary/dispatch`, `/desktop/**`.
- [ ] Audit the provider keys in `secrets.env` — revoke anything you won't
      use in production.
- [ ] Disable the host bridge on any server that isn't a macOS workstation.
- [ ] Run `gitleaks detect` before every push.
