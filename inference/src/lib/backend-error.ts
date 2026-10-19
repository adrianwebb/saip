/**
 * Translate a backend failure into an HTTP response.
 *
 * Lives here rather than in each route so chat, systemone, and any later engine consumer
 * answer an engine outage identically. The distinction that matters to a caller is whether
 * the model server is sick (502/503/504 — go read `docker compose logs vllm`) or SAIP is
 * (500 — file a bug).
 */
import { VllmBackendError, type VllmErrorKind } from './vllm-http.js'

const STATUS_BY_KIND: Record<VllmErrorKind, number> = {
  backend_error: 502,
  backend_timeout: 504,
  backend_unavailable: 503,
}

/** `[status, body]` for a failed request, or `undefined` when this is not a backend error. */
export function mapBackendError(err: unknown): { status: number; body: { error: { message: string; type: string; code: string } } } | undefined {
  const kind = err instanceof VllmBackendError ? err.kind : undefined
  const status = kind ? STATUS_BY_KIND[kind] : 500
  const code = kind ?? 'internal_error'
  const message = err instanceof Error ? err.message : String(err)
  return {
    status,
    body: {
      error: {
        message,
        type: kind ? 'upstream_error' : 'internal_server_error',
        code,
      },
    },
  }
}
