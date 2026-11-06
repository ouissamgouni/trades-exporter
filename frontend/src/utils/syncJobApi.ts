import { API_URL, BlockingJobInfo } from '../types';

export class ApiError extends Error {
    constructor(message: string, public status: number, public detail: unknown) {
        super(message);
    }
}

/** FastAPI `detail` is either a string or a structured `{ message, ... }` object; body may not be JSON. */
export async function readApiError(response: Response, fallback: string): Promise<ApiError> {
    let detail: unknown = null;
    try {
        detail = (await response.json())?.detail ?? null;
    } catch {
        // non-JSON error body (e.g. proxy error page)
    }
    let message = `${fallback} (HTTP ${response.status})`;
    if (typeof detail === 'string') {
        message = detail;
    } else if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
        message = (detail as { message: string }).message;
    }
    return new ApiError(message, response.status, detail);
}

export function getBlockingJob(err: unknown): BlockingJobInfo | null {
    if (!(err instanceof ApiError) || !err.detail || typeof err.detail !== 'object') return null;
    const detail = err.detail as { code?: string; blocking_job?: BlockingJobInfo };
    return detail.code === 'sync_job_active' && detail.blocking_job ? detail.blocking_job : null;
}

export interface AbortSyncJobResponse {
    status: string;
    message: string;
    job_id?: number;
}

/** Abort the current job, or a specific one (also clears jobs stuck with no worker). */
export async function abortSyncJob(jobId?: number): Promise<AbortSyncJobResponse> {
    const url = jobId == null ? `${API_URL}/sync-job/abort` : `${API_URL}/sync-job/jobs/${jobId}/abort`;
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw await readApiError(response, 'Failed to abort job');
    return response.json();
}
