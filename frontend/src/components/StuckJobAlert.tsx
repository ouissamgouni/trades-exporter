import React, { useState } from 'react';
import { FiAlertTriangle } from 'react-icons/fi';
import { BlockingJobInfo } from '../types';
import { formatDateTimeLocale, formatRelativeTime } from '../utils/dateUtils';
import { abortSyncJob } from '../utils/syncJobApi';
import { Button } from './ui/primitives';
import { toaster } from './ui/toaster';

interface StuckJobAlertProps {
    job: Pick<BlockingJobInfo, 'id' | 'status' | 'started_at'>;
    onAborted: () => void;
}

/** Shown when a DB job is pending/running but no worker runs it — it blocks every new sync. */
export const StuckJobAlert: React.FC<StuckJobAlertProps> = ({ job, onAborted }) => {
    const [aborting, setAborting] = useState(false);

    const handleAbort = async () => {
        setAborting(true);
        try {
            const result = await abortSyncJob(job.id ?? undefined);
            toaster.success({ title: `Job #${job.id} aborted`, description: result.message });
            onAborted();
        } catch (err) {
            toaster.error({ title: 'Abort failed', description: err instanceof Error ? err.message : 'Failed to abort job' });
        } finally {
            setAborting(false);
        }
    };

    return (
        <div role="alert" className="mb-4 flex flex-wrap items-start justify-between gap-3 border border-red-200 bg-red-50 p-3">
            <div className="flex min-w-0 items-start gap-2">
                <FiAlertTriangle className="mt-0.5 shrink-0 text-red-500" size={16} aria-hidden />
                <div className="min-w-0">
                    <p className="font-semibold text-red-800">
                        Sync job #{job.id} is stuck and blocks new syncs
                    </p>
                    <p className="text-sm text-red-700">
                        It has been <span className="font-semibold">{job.status}</span> since{' '}
                        {formatDateTimeLocale(job.started_at)} ({formatRelativeTime(job.started_at)}) but no worker
                        is running it, most likely because the server restarted. Abort it to start a new sync.
                    </p>
                </div>
            </div>
            <Button colorScheme="red" variant="outline" size="sm" onClick={handleAbort} loading={aborting}>
                Abort stuck job
            </Button>
        </div>
    );
};
