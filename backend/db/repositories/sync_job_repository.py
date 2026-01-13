"""
Sync Job Repository - CRUD operations for sync jobs and connector runs.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlmodel import Session, select, col

from backend.db.models import (
    SyncJob,
    SyncJobConnectorRun,
    SyncJobStatus,
    SyncJobConnectorStatus,
    NormalizedTransaction,
)


class SyncJobRepository:
    """Repository for SyncJob and SyncJobConnectorRun CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    # --- SyncJob CRUD ---

    def create_job(
        self,
        config_snapshot: Optional[Dict[str, Any]] = None,
    ) -> SyncJob:
        """Create a new sync job."""
        job = SyncJob(
            status=SyncJobStatus.IDLE,
            started_at=datetime.now(timezone.utc),
            config_snapshot=config_snapshot or {},
            total_connectors=0,
            total_processed=0,
            total_new=0,
            total_updated=0,
            total_skipped=0,
            total_errors=0,
        )
        self.session.add(job)
        self.session.flush()
        self.session.refresh(job)
        return job

    def get_job(self, job_id: int) -> Optional[SyncJob]:
        """Get a sync job by ID."""
        return self.session.get(SyncJob, job_id)

    def get_job_with_runs(self, job_id: int) -> Optional[SyncJob]:
        """Get a sync job by ID with all connector runs loaded."""
        job = self.session.get(SyncJob, job_id)
        if job:
            # Force load connector_runs relationship
            _ = job.connector_runs
        return job

    def list_jobs(
        self,
        limit: int = 50,
        offset: int = 0,
        status: Optional[SyncJobStatus] = None,
    ) -> List[SyncJob]:
        """List sync jobs with optional filtering."""
        statement = select(SyncJob).order_by(col(SyncJob.started_at).desc())
        if status:
            statement = statement.where(SyncJob.status == status)
        statement = statement.offset(offset).limit(limit)
        return list(self.session.exec(statement).all())

    def count_jobs(self, status: Optional[SyncJobStatus] = None) -> int:
        """Count total sync jobs."""
        from sqlmodel import func

        statement = select(func.count()).select_from(SyncJob)
        if status:
            statement = statement.where(SyncJob.status == status)
        return self.session.exec(statement).one()

    def update_job_status(
        self,
        job_id: int,
        status: SyncJobStatus,
        error_message: Optional[str] = None,
    ) -> Optional[SyncJob]:
        """Update job status and optionally set error message."""
        job = self.get_job(job_id)
        if not job:
            return None

        job.status = status
        if error_message:
            job.error_message = error_message

        # Set finished_at for terminal states
        if status in (
            SyncJobStatus.COMPLETED,
            SyncJobStatus.FAILED,
            SyncJobStatus.ABORTED,
        ):
            job.finished_at = datetime.now(timezone.utc)

        self.session.add(job)
        self.session.flush()
        return job

    def update_job_totals(
        self,
        job_id: int,
        total_connectors: Optional[int] = None,
        total_processed: Optional[int] = None,
        total_new: Optional[int] = None,
        total_updated: Optional[int] = None,
        total_skipped: Optional[int] = None,
        total_errors: Optional[int] = None,
    ) -> Optional[SyncJob]:
        """Update job aggregate statistics."""
        job = self.get_job(job_id)
        if not job:
            return None

        if total_connectors is not None:
            job.total_connectors = total_connectors
        if total_processed is not None:
            job.total_processed = total_processed
        if total_new is not None:
            job.total_new = total_new
        if total_updated is not None:
            job.total_updated = total_updated
        if total_skipped is not None:
            job.total_skipped = total_skipped
        if total_errors is not None:
            job.total_errors = total_errors

        self.session.add(job)
        self.session.flush()
        return job

    def recalculate_job_totals(self, job_id: int) -> Optional[SyncJob]:
        """Recalculate job totals from connector runs."""
        job = self.get_job(job_id)
        if not job:
            return None

        runs = self.get_connector_runs_for_job(job_id)

        job.total_connectors = len(runs)
        job.total_processed = sum(r.processed or 0 for r in runs)
        job.total_new = sum(r.synced_count or 0 for r in runs)
        job.total_updated = sum(r.updated_count or 0 for r in runs)
        job.total_skipped = sum(r.skipped_count or 0 for r in runs)
        job.total_errors = sum(r.error_count or 0 for r in runs)

        self.session.add(job)
        self.session.flush()
        return job

    # --- SyncJobConnectorRun CRUD ---

    def create_connector_run(
        self,
        job_id: int,
        connector_id: int,
        test_mode: bool = False,
    ) -> SyncJobConnectorRun:
        """Create a new connector run for a job."""
        run = SyncJobConnectorRun(
            job_id=job_id,
            connector_id=connector_id,
            status=SyncJobConnectorStatus.QUEUED,
            test_mode=test_mode,
            started_at=None,
            processed=0,
            synced_count=0,
            updated_count=0,
            skipped_count=0,
            error_count=0,
            synced_ids=[],
            updated_ids=[],
            skipped_ids=[],
            error_details=[],
            logs=[],
        )
        self.session.add(run)
        self.session.flush()
        self.session.refresh(run)
        return run

    def get_connector_run(self, run_id: int) -> Optional[SyncJobConnectorRun]:
        """Get a connector run by ID."""
        return self.session.get(SyncJobConnectorRun, run_id)

    def get_connector_runs_for_job(self, job_id: int) -> List[SyncJobConnectorRun]:
        """Get all connector runs for a job."""
        statement = (
            select(SyncJobConnectorRun)
            .where(SyncJobConnectorRun.job_id == job_id)
            .order_by(SyncJobConnectorRun.id)
        )
        return list(self.session.exec(statement).all())

    def update_connector_run_status(
        self,
        run_id: int,
        status: SyncJobConnectorStatus,
        error_message: Optional[str] = None,
    ) -> Optional[SyncJobConnectorRun]:
        """Update connector run status."""
        run = self.get_connector_run(run_id)
        if not run:
            return None

        run.status = status

        # Set started_at when transitioning to running
        if status == SyncJobConnectorStatus.RUNNING and not run.started_at:
            run.started_at = datetime.now(timezone.utc)

        # Set finished_at for terminal states
        if status in (
            SyncJobConnectorStatus.COMPLETED,
            SyncJobConnectorStatus.FAILED,
            SyncJobConnectorStatus.SKIPPED,
            SyncJobConnectorStatus.ABORTED,
        ):
            run.finished_at = datetime.now(timezone.utc)

        self.session.add(run)
        self.session.flush()
        return run

    def update_connector_run_metrics(
        self,
        run_id: int,
        processed: Optional[int] = None,
        synced_count: Optional[int] = None,
        updated_count: Optional[int] = None,
        skipped_count: Optional[int] = None,
        error_count: Optional[int] = None,
    ) -> Optional[SyncJobConnectorRun]:
        """Update connector run metrics."""
        run = self.get_connector_run(run_id)
        if not run:
            return None

        if processed is not None:
            run.processed = processed
        if synced_count is not None:
            run.synced_count = synced_count
        if updated_count is not None:
            run.updated_count = updated_count
        if skipped_count is not None:
            run.skipped_count = skipped_count
        if error_count is not None:
            run.error_count = error_count

        self.session.add(run)
        self.session.flush()
        return run

    def update_connector_run_outcomes(
        self,
        run_id: int,
        synced_ids: Optional[List[str]] = None,
        updated_ids: Optional[List[str]] = None,
        skipped_ids: Optional[List[str]] = None,
        error_details: Optional[List[Dict[str, Any]]] = None,
    ) -> Optional[SyncJobConnectorRun]:
        """Update connector run outcome tracking (which transactions were affected)."""
        run = self.get_connector_run(run_id)
        if not run:
            return None

        if synced_ids is not None:
            run.synced_ids = synced_ids
        if updated_ids is not None:
            run.updated_ids = updated_ids
        if skipped_ids is not None:
            run.skipped_ids = skipped_ids
        if error_details is not None:
            run.error_details = error_details

        self.session.add(run)
        self.session.flush()
        return run

    def append_connector_run_log(
        self,
        run_id: int,
        level: str,
        message: str,
        timestamp: Optional[datetime] = None,
    ) -> Optional[SyncJobConnectorRun]:
        """Append a log entry to connector run."""
        run = self.get_connector_run(run_id)
        if not run:
            return None

        log_entry = {
            "timestamp": (timestamp or datetime.now(timezone.utc)).isoformat(),
            "level": level,
            "message": message,
        }
        run.logs = (run.logs or []) + [log_entry]

        self.session.add(run)
        self.session.flush()
        return run

    def complete_connector_run(
        self,
        run_id: int,
        processed: int,
        synced_count: int,
        updated_count: int,
        skipped_count: int,
        error_count: int,
        synced_ids: List[str],
        updated_ids: List[str],
        skipped_ids: List[str],
        error_details: List[Dict[str, Any]],
    ) -> Optional[SyncJobConnectorRun]:
        """
        Complete a connector run with all final metrics and outcomes.

        This is a convenience method that sets all metrics and marks as completed.
        """
        run = self.get_connector_run(run_id)
        if not run:
            return None

        run.status = SyncJobConnectorStatus.COMPLETED
        run.finished_at = datetime.now(timezone.utc)
        run.processed = processed
        run.synced_count = synced_count
        run.updated_count = updated_count
        run.skipped_count = skipped_count
        run.error_count = error_count
        run.synced_ids = synced_ids
        run.updated_ids = updated_ids
        run.skipped_ids = skipped_ids
        run.error_details = error_details

        self.session.add(run)
        self.session.flush()
        return run

    # --- Query helpers ---

    def get_transactions_for_connector_run(
        self,
        run_id: int,
        limit: int = 100,
        offset: int = 0,
    ) -> List[NormalizedTransaction]:
        """Get all transactions created/updated by a specific connector run."""
        statement = (
            select(NormalizedTransaction)
            .where(NormalizedTransaction.sync_connector_run_id == run_id)
            .order_by(col(NormalizedTransaction.date_time).desc())
            .offset(offset)
            .limit(limit)
        )
        return list(self.session.exec(statement).all())

    def count_transactions_for_connector_run(self, run_id: int) -> int:
        """Count transactions for a connector run."""
        from sqlmodel import func

        statement = (
            select(func.count())
            .select_from(NormalizedTransaction)
            .where(NormalizedTransaction.sync_connector_run_id == run_id)
        )
        return self.session.exec(statement).one()

    def get_transactions_for_job(
        self,
        job_id: int,
        limit: int = 100,
        offset: int = 0,
    ) -> List[NormalizedTransaction]:
        """Get all transactions created/updated by any connector in a job."""
        # Get all connector run IDs for this job
        run_ids_statement = select(SyncJobConnectorRun.id).where(
            SyncJobConnectorRun.job_id == job_id
        )
        run_ids = list(self.session.exec(run_ids_statement).all())

        if not run_ids:
            return []

        statement = (
            select(NormalizedTransaction)
            .where(col(NormalizedTransaction.sync_connector_run_id).in_(run_ids))
            .order_by(col(NormalizedTransaction.date_time).desc())
            .offset(offset)
            .limit(limit)
        )
        return list(self.session.exec(statement).all())

    def count_transactions_for_job(self, job_id: int) -> int:
        """Count all transactions for a job."""
        from sqlmodel import func

        run_ids_statement = select(SyncJobConnectorRun.id).where(
            SyncJobConnectorRun.job_id == job_id
        )
        run_ids = list(self.session.exec(run_ids_statement).all())

        if not run_ids:
            return 0

        statement = (
            select(func.count())
            .select_from(NormalizedTransaction)
            .where(col(NormalizedTransaction.sync_connector_run_id).in_(run_ids))
        )
        return self.session.exec(statement).one()

    # --- Heartbeat and Cleanup ---

    def update_heartbeat(self, job_id: int) -> Optional[SyncJob]:
        """Update the last_heartbeat timestamp for a running job."""
        job = self.get_job(job_id)
        if not job:
            return None
        
        job.last_heartbeat = datetime.now(timezone.utc)
        self.session.add(job)
        self.session.flush()
        return job

    def cleanup_orphaned_jobs(self, stale_minutes: int = 5) -> Dict[str, int]:
        """
        Clean up jobs that are stuck in 'running' status after a server crash.
        
        Marks running jobs as 'aborted' if:
        - last_heartbeat is older than stale_minutes, OR
        - last_heartbeat is NULL (legacy jobs or heartbeat never set)
        
        Also marks their connector runs with 'running' or 'queued' status as 'failed'.
        
        Returns a dict with counts of affected jobs and connector runs.
        """
        from sqlmodel import func, or_
        from datetime import timedelta
        
        now = datetime.now(timezone.utc)
        stale_threshold = now - timedelta(minutes=stale_minutes)
        
        # Find stale running jobs
        stale_jobs_statement = select(SyncJob).where(
            SyncJob.status == SyncJobStatus.RUNNING,
            or_(
                SyncJob.last_heartbeat.is_(None),
                SyncJob.last_heartbeat < stale_threshold,
            )
        )
        stale_jobs = list(self.session.exec(stale_jobs_statement).all())
        
        if not stale_jobs:
            return {"jobs_aborted": 0, "connector_runs_failed": 0}
        
        job_ids = [job.id for job in stale_jobs]
        connector_runs_updated = 0
        
        # Mark stale jobs as aborted
        for job in stale_jobs:
            job.status = SyncJobStatus.ABORTED
            job.finished_at = now
            job.error_message = "Job aborted: Server restarted unexpectedly or job became stale"
            self.session.add(job)
        
        # Mark their running/queued connector runs as failed
        connector_runs_statement = select(SyncJobConnectorRun).where(
            SyncJobConnectorRun.job_id.in_(job_ids),
            SyncJobConnectorRun.status.in_([
                SyncJobConnectorStatus.RUNNING,
                SyncJobConnectorStatus.QUEUED,
            ])
        )
        connector_runs = list(self.session.exec(connector_runs_statement).all())
        
        for run in connector_runs:
            run.status = SyncJobConnectorStatus.FAILED
            run.finished_at = now
            run.error_message = "Connector run failed: Job was aborted due to server restart or stale state"
            self.session.add(run)
            connector_runs_updated += 1
        
        self.session.flush()
        
        return {
            "jobs_aborted": len(stale_jobs),
            "connector_runs_failed": connector_runs_updated,
        }
