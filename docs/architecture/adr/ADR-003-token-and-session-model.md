# ADR-003: Token and session model

- **Status:** Accepted (2026-11-20) · **Date:** 2026-11-20

## Context
Requirements: short-lived access tokens, refresh rotation with reuse detection, revocable device sessions, logout-all, no long-lived tokens in localStorage, four browser apps.

## Decision
- **Session row per device login** (`user_sessions`), the unit of revocation; refresh tokens form a family per session.
- **Access token:** JWT (HS256 with `kid` key ring; switch to EdDSA if other services must verify without sharing the secret), 15 min, kept in memory. Each request also checks session status via a Redis cache (≤ 30 s, synchronously invalidated) so revocation is effectively immediate.
- **Refresh token:** opaque 256-bit random, stored as SHA-256 hash, sent in an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie named per app; rotated on every use; reuse after a 10 s grace window revokes the session; reuse within grace returns `409 AUTH_REFRESH_RACE` (multi-tab safety). Frontend uses single-flight refresh with a cross-tab lock.
- **CSRF:** only cookie-authenticated endpoints are refresh/logout; protected by SameSite=Strict + Origin allowlist + custom header.
- Admin sessions: 12 h absolute / 1 h idle, MFA.

## Alternatives
- Refresh token in localStorage — XSS-exfiltratable; rejected (owner mandate).
- Pure stateless JWT without session checks — cannot revoke promptly; rejected.
- Server-side session cookies only (no JWT) — viable, but sockets and future service extraction benefit from self-contained access tokens; JWT + session check gives both.

## Consequences
+ Theft of a refresh token is detectable; sessions individually revocable; XSS cannot read refresh tokens.
− Requires same-site deployment of app origins and API (documented in infra); careful frontend refresh logic.
