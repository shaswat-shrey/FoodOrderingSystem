import type { ReadinessReport } from '@fos/types';

export type DependencyCheck = () => Promise<void>;

/** Receives the underlying failure so it can be logged; it is never put in the response. */
export type CheckFailureReporter = (name: string, error: unknown) => void;

export interface ReadinessChecks {
  /** Required: without the database nothing can be served (NFR-AVAIL-005). */
  critical: Record<string, DependencyCheck>;
  /** Degradable: the API keeps serving with fallbacks (NFR-AVAIL-004). */
  degradable: Record<string, DependencyCheck>;
}

const CHECK_TIMEOUT_MS = 2000;

class CheckTimeoutError extends Error {}

async function runCheck(name: string, check: DependencyCheck, onFailure?: CheckFailureReporter) {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new CheckTimeoutError(`timed out after ${CHECK_TIMEOUT_MS} ms`)),
          CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return { status: 'up' as const, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    onFailure?.(name, error);
    // Generic reason only: raw driver errors contain hostnames and ports.
    return {
      status: 'down' as const,
      error: error instanceof CheckTimeoutError ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function evaluateReadiness(
  checks: ReadinessChecks,
  onFailure?: CheckFailureReporter,
): Promise<ReadinessReport> {
  const entries = [
    ...Object.entries(checks.critical).map(([name, check]) => ({ name, check, critical: true })),
    ...Object.entries(checks.degradable).map(([name, check]) => ({ name, check, critical: false })),
  ];
  const results = await Promise.all(
    entries.map(async (e) => ({ ...e, result: await runCheck(e.name, e.check, onFailure) })),
  );
  const report: ReadinessReport = { status: 'ok', checks: {} };
  for (const { name, critical, result } of results) {
    report.checks[name] = result;
    if (result.status === 'down') {
      report.status = critical
        ? 'unavailable'
        : report.status === 'unavailable'
          ? 'unavailable'
          : 'degraded';
    }
  }
  return report;
}
