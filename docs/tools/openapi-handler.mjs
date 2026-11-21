// Stand-in for apps/api/src/platform/http/handler.ts used only while generating the
// OpenAPI document (see openapi-hooks.mjs). Same behaviour as the original
// `handle`, plus the schemas attached to the handler for the generator to read.
// Keep in step with handler.ts if its signature changes.

export const OPENAPI_SCHEMAS = Symbol.for('fos.openapi.schemas');

export function handle(schemas, fn) {
  const handler = async (req, res) => {
    const body = schemas.body ? schemas.body.parse(req.body ?? {}) : undefined;
    const query = schemas.query ? schemas.query.parse(req.query) : undefined;
    const params = schemas.params ? schemas.params.parse(req.params) : undefined;
    await fn({ body, query, params, req, res });
  };
  handler[OPENAPI_SCHEMAS] = schemas;
  return handler;
}
