// Module customization hook for docs/tools/openapi.mjs.
//
// Every API route is wrapped by `handle(schemas, fn)` from
// apps/api/src/platform/http/handler.ts, which keeps its Zod schemas in a closure.
// For the generator only, this hook swaps that module for
// docs/tools/openapi-handler.mjs, whose `handle` behaves the same but also
// exposes the schemas on the returned function. The running API is unaffected.

const HANDLER = /\/apps\/api\/src\/platform\/http\/handler\.ts$/;
const REPLACEMENT = new URL('./openapi-handler.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (HANDLER.test(new URL(result.url).pathname)) {
    return { ...result, url: REPLACEMENT, format: 'module', shortCircuit: true };
  }
  return result;
}
