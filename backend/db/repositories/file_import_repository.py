"""
File Import Repository - CRUD operations for file imports.
"""

import os
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from sqlmodel import Session, select

from backend.db.models import FileImport, FileImportStatus


# Default retention period in days (can be overridden via environment variable)
DEFAULT_RETENTION_DAYS = 90


def get_retention_days() -> int:
    """Get retention period from environment or use default."""
    return int(os.environ.get("FILE_IMPORT_RETENTION_DAYS", DEFAULT_RETENTION_DAYS))


class FileImportRepository:
    """Repository for FileImport CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, file_import: FileImport) -> FileImport:
        """
        Create a new file import record.
        
        Sets retention_expires_at based on configured retention period.
        """
        if file_import.retention_expires_at is None:
            retention_days = get_retention_days()
            file_import.retention_expires_at = datetime.now(timezone.utc) + timedelta(days=retention_days)
        
        self.session.add(file_import)
        self.session.flush()
        self.session.refresh(file_import)
        return file_import

    def get(self, file_import_id: int) -> Optional[FileImport]:
        """Get a file import by ID."""
        return self.session.get(FileImport, file_import_id)

    def get_by_connector(
        self,
        connector_id: int,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[FileImport]:
        """
        Get file imports for a connector with optional status filter.
        
        Args:
            connector_id: The connector ID to filter by
            status: Optional status filter (pending, processing, completed, failed)
            limit: Maximum number of records to return
            offset: Number of records to skip
            
        Returns:
            List of FileImport records ordered by uploaded_at descending
        """
        statement = select(FileImport).where(FileImport.connector_id == connector_id)
        
        if status:
            statement = statement.where(FileImport.status == status)
        
        statement = statement.order_by(FileImport.uploaded_at.desc()).offset(offset).limit(limit)
        
        return list(self.session.exec(statement).all())

    def get_pending_by_connector(self, connector_id: int) -> List[FileImport]:
        """Get all pending file imports for a connector."""
        return self.get_by_connector(connector_id, status=FileImportStatus.PENDING.value)

    def get_latest_pending(self, connector_id: int) -> Optional[FileImport]:
        """Get the most recent pending file import for a connector."""
        pending = self.get_pending_by_connector(connector_id)
        return pending[0] if pending else None

    def update_status(
        self,
        file_import_id: int,
        status: str,
        error_message: Optional[str] = None,
        sync_job_connector_run_id: Optional[int] = None,
        metrics: Optional[dict] = None,
    ) -> Optional[FileImport]:
        """
        Update file import status and optionally set metrics.
        
        Args:
            file_import_id: The file import ID
            status: New status (pending, processing, completed, failed)
            error_message: Optional error message for failed imports
            sync_job_connector_run_id: Optional link to the sync job connector run
            metrics: Optional dict with new_count, updated_count, skipped_count
            
        Returns:
            Updated FileImport or None if not found
        """
        file_import = self.get(file_import_id)
        if not file_import:
            return None
        
        file_import.status = status
        file_import.updated_at = datetime.now(timezone.utc)
        
        if status in [FileImportStatus.COMPLETED.value, FileImportStatus.FAILED.value]:
            file_import.processed_at = datetime.now(timezone.utc)
        
        if error_message is not None:
            file_import.error_message = error_message
        
        if sync_job_connector_run_id is not None:
            file_import.sync_job_connector_run_id = sync_job_connector_run_id
        
        if metrics:
            if "new_count" in metrics:
                file_import.new_count = metrics["new_count"]
            if "updated_count" in metrics:
                file_import.updated_count = metrics["updated_count"]
            if "skipped_count" in metrics:
                file_import.skipped_count = metrics["skipped_count"]
            if "row_count" in metrics:
                file_import.row_count = metrics["row_count"]
        
        self.session.add(file_import)
        self.session.flush()
        self.session.refresh(file_import)
        return file_import

    def mark_processing(
        self,
        file_import_id: int,
        sync_job_connector_run_id: Optional[int] = None,
    ) -> Optional[FileImport]:
        """Mark a file import as processing."""
        return self.update_status(
            file_import_id,
            FileImportStatus.PROCESSING.value,
            sync_job_connector_run_id=sync_job_connector_run_id,
        )

    def mark_completed(
        self,
        file_import_id: int,
        new_count: int = 0,
        updated_count: int = 0,
        skipped_count: int = 0,
    ) -> Optional[FileImport]:
        """Mark a file import as completed with metrics."""
        return self.update_status(
            file_import_id,
            FileImportStatus.COMPLETED.value,
            metrics={
                "new_count": new_count,
                "updated_count": updated_count,
                "skipped_count": skipped_count,
            },
        )

    def mark_failed(
        self,
        file_import_id: int,
        error_message: str,
    ) -> Optional[FileImport]:
        """Mark a file import as failed with error message."""
        return self.update_status(
            file_import_id,
            FileImportStatus.FAILED.value,
            error_message=error_message,
        )

    def get_expired(self) -> List[FileImport]:
        """
        Get all file imports that have passed their retention expiry.
        
        Returns completed/failed imports that are past retention_expires_at.
        Does NOT return pending/processing imports.
        """
        now = datetime.now(timezone.utc)
        statement = (
            select(FileImport)
            .where(FileImport.retention_expires_at < now)
            .where(FileImport.status.in_([
                FileImportStatus.COMPLETED.value,
                FileImportStatus.FAILED.value,
            ]))
        )
        return list(self.session.exec(statement).all())

    def cleanup_expired(self) -> int:
        """
        Delete all expired file import records.
        
        Also attempts to delete any orphaned files for failed imports.
        
        Returns:
            Number of records deleted
        """
        expired = self.get_expired()
        count = 0
        
        for file_import in expired:
            # Try to delete file if it still exists (for failed imports)
            if file_import.file_path and os.path.exists(file_import.file_path):
                try:
                    os.remove(file_import.file_path)
                except OSError:
                    pass  # File deletion failure shouldn't prevent record cleanup
            
            self.session.delete(file_import)
            count += 1
        
        if count > 0:
            self.session.flush()
        
        return count

    def delete(self, file_import_id: int) -> bool:
        """
        Delete a file import record.
        
        Also deletes the associated file if it exists.
        
        Returns:
            True if deleted, False if not found
        """
        file_import = self.get(file_import_id)
        if not file_import:
            return False
        
        # Delete file if it exists
        if file_import.file_path and os.path.exists(file_import.file_path):
            try:
                os.remove(file_import.file_path)
            except OSError:
                pass
        
        self.session.delete(file_import)
        return True

    def count_by_status(self, connector_id: int) -> dict:
        """
        Get count of file imports by status for a connector.
        
        Returns:
            Dict with status -> count mapping
        """
        from sqlalchemy import func
        
        statement = (
            select(FileImport.status, func.count(FileImport.id))
            .where(FileImport.connector_id == connector_id)
            .group_by(FileImport.status)
        )
        
        results = self.session.exec(statement).all()
        return {status: count for status, count in results}
