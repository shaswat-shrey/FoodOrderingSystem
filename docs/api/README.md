# API documentation

[`openapi.json`](openapi.json) is an **OpenAPI 3.1** document generated from the code. Do not edit it by hand.

```bash
pnpm docs:api            # regenerate after changing routes or their Zod schemas
pnpm docs:api --check    # exit 1 if the committed document is out of date
```

## How it is generated

[`docs/tools/openapi.mjs`](../tools/openapi.mjs) (run with `tsx` from `apps/api`, no database or Redis needed):

1. Builds the Express app exactly as the server and the integration tests do (`createApp` + `mountRoutes`/`mountRawRoutes`), with lazy database and Redis clients that never connect.
2. Walks the Express router stack, like the authorization-matrix test (`apps/api/test/authz-matrix.integration.test.ts`), so every mounted route appears and nothing else does.
3. Reads each route's Zod schemas for **path parameters, query and JSON body**. Every route validates through `handle(schemas, fn)`; for the generator only, a Node module hook ([`openapi-hooks.mjs`](../tools/openapi-hooks.mjs)) swaps `handler.ts` for [`openapi-handler.mjs`](../tools/openapi-handler.mjs), which behaves the same and also exposes the schemas. They become JSON Schema through zod 4's `z.toJSONSchema` (input side: defaults are shown, optional fields are not required).
4. Takes the summary, SRS ID (`x-srs-id`) and access notation of each operation from the API-\* tables in [API-SPECIFICATION.md](../requirements/API-SPECIFICATION.md), matched on method and path.
5. Sets security from the path, using the same audience rules as the authorization matrix: public routes have `security: []`, the rest need a bearer token and the matching `X-Client-App`.

## What it covers

- 345 paths, 395 operations: everything mounted under `/api/v1` plus `/health/live` and `/health/ready`.
- Request schemas (path parameters, query and/or JSON body) for 347 operations; the other 45 validated operations take no input (for example `GET /me`, `POST /auth/logout`). Three routes are not wrapped by `handle()`: the payment webhook (raw body checked against the provider signature) and the two health checks. The multipart upload `POST /api/v1/files` is described as `multipart/form-data` with `purpose` and `file` parts.
- 392 operations carry an SRS ID. The three without one are implementation extras recorded in PROJECT_STATUS.md: `GET /merchant/cuisines`, `GET /merchant/branches/{bid}/go-live` and the development-only `POST /payments/{paymentId}/mock-checkout` (it answers 404 unless the mock payment provider is active).
- **Responses** are described by the common envelope only (`SuccessEnvelope`, `ErrorEnvelope`): handlers build their responses in code, not from schemas. Error codes are listed in [ERROR-HANDLING.md](../requirements/ERROR-HANDLING.md); the critical endpoints' payloads are specified in [API-SPECIFICATION.md §14.3](../requirements/API-SPECIFICATION.md).
- Not included: signed media and private-file links (`/api/v1/media/*`, `/api/v1/files/private/*`, served by the local storage driver as regex routes) and the Socket.IO protocol (rooms and events: [REALTIME-REQUIREMENTS.md](../requirements/REALTIME-REQUIREMENTS.md)).

## Conventions (all operations)

- Base path `/api/v1`; JSON in camelCase; money as integer paise; ids are UUIDv7; timestamps ISO-8601 UTC.
- Send `X-Client-App: CUSTOMER | RESTAURANT | DELIVERY | ADMIN` on every browser and authenticated request; it must match the token audience and the request `Origin`.
- `Authorization: Bearer <accessToken>`; the refresh token is an httpOnly cookie on `/api/v1/auth` (`POST /auth/refresh`).
- `Idempotency-Key` (UUID) on money-moving and creation requests marked **Idem** in the SRS; replays return the stored response with `Idempotent-Replayed: true`.
- Rate limits answer `429` with `Retry-After`.

## Viewing it

No viewer is bundled. Any of these works without adding dependencies to the repository:

```bash
# Swagger UI in Docker, at http://localhost:8080
docker run --rm -p 8080:8080 -e SWAGGER_JSON=/spec/openapi.json -v "$PWD/docs/api:/spec" swaggerapi/swagger-ui

# Redocly CLI preview, or a static HTML file
npx @redocly/cli preview-docs docs/api/openapi.json
npx @redocly/cli build-docs docs/api/openapi.json -o openapi.html

# Lint it
npx @redocly/cli lint docs/api/openapi.json
```

Editors such as VS Code (OpenAPI extensions), Postman and Insomnia import the file directly. To try requests against a local API, sign in through the web app or `POST /api/v1/auth/otp/request` + `/auth/otp/login` (codes in `.local/dev-messages.log`) and use the returned `accessToken` with the matching `X-Client-App`.

The SRS reserves `GET /api/v1/openapi.json` and `/api/docs` (API-SYS-004) for serving the document from the API; that endpoint is not built — the file in this folder is the published contract.
