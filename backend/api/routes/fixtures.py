"""
API routes for test fixture file management.

Provides endpoints for listing, uploading, and deleting connector test fixtures.
"""

import os
import json
from pathlib import Path
from typing import List, Optional
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from sqlmodel import Session
from pydantic import BaseModel

from backend.db.models import AccountConnector
from backend.db.database import get_session_dependency
from backend.config.loader import configure_logging

log = configure_logging("fixtures_api")

router = APIRouter(prefix="/fixtures", tags=["fixtures"])

# Base directory for uploaded test fixtures
FIXTURES_DIR = Path(__file__).parent.parent.parent / "data" / "input" / "fixtures"
# Maximum file size (1MB)
MAX_FILE_SIZE = 1 * 1024 * 1024


# ============================================================================
# Pydantic Models
# ============================================================================


class FixtureInfo(BaseModel):
    """Information about a fixture file."""
    filename: str
    size_bytes: int
    connector_id: Optional[int] = None


class FixtureUploadResponse(BaseModel):
    """Response after uploading a fixture."""
    filename: str
    path: str
    size_bytes: int
    item_count: int


# ============================================================================
# Helper Functions
# ============================================================================


def ensure_fixtures_dir():
    """Ensure the fixtures directory exists."""
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)


def get_fixture_path(connector_id: int) -> Path:
    """Get the path to a connector's fixture file."""
    return FIXTURES_DIR / f"{connector_id}.json"


def delete_fixture_file(connector_id: int) -> bool:
    """
    Delete a connector's fixture file if it exists.
    
    Returns:
        True if file was deleted, False if it didn't exist
    """
    fixture_path = get_fixture_path(connector_id)
    if fixture_path.exists():
        fixture_path.unlink()
        log.info(f"Deleted fixture file: {fixture_path}")
        return True
    return False


# ============================================================================
# API Routes
# ============================================================================


@router.get("/", response_model=List[FixtureInfo])
def list_fixtures():
    """
    List all available fixture files.
    
    Returns fixture files from both:
    - Default fixtures: tests/e2e/fixtures/
    - Uploaded fixtures: data/input/fixtures/
    """
    fixtures = []
    
    # List uploaded fixtures
    ensure_fixtures_dir()
    for file_path in FIXTURES_DIR.glob("*.json"):
        try:
            # Try to extract connector_id from filename (format: {id}.json)
            connector_id = None
            stem = file_path.stem
            if stem.isdigit():
                connector_id = int(stem)
            
            fixtures.append(FixtureInfo(
                filename=file_path.name,
                size_bytes=file_path.stat().st_size,
                connector_id=connector_id,
            ))
        except Exception as e:
            log.warning(f"Error reading fixture {file_path}: {e}")
    
    # List default fixtures from tests/e2e/fixtures
    default_fixtures_dir = Path(__file__).parent.parent.parent / "tests" / "e2e" / "fixtures"
    if default_fixtures_dir.exists():
        for file_path in default_fixtures_dir.glob("*.json"):
            fixtures.append(FixtureInfo(
                filename=file_path.name,
                size_bytes=file_path.stat().st_size,
                connector_id=None,  # Default fixtures are not connector-specific
            ))
    
    return fixtures


@router.post("/connectors/{connector_id}/test-fixture", response_model=FixtureUploadResponse)
async def upload_connector_fixture(
    connector_id: int,
    file: UploadFile = File(...),
    session: Session = Depends(get_session_dependency),
):
    """
    Upload a test fixture file for a specific connector.
    
    - Validates the file is JSON and contains an array
    - Saves to data/input/fixtures/{connector_id}.json
    - Updates connector config with test_mode=true and test_file_path
    
    Args:
        connector_id: The connector ID to associate the fixture with
        file: The JSON fixture file to upload
    """
    # Verify connector exists
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    # Validate file extension
    if not file.filename or not file.filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="File must be a .json file")
    
    # Read file content
    content = await file.read()
    
    # Validate file size
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE / 1024 / 1024:.1f}MB"
        )
    
    # Validate JSON and that it's an array
    try:
        data = json.loads(content)
        if not isinstance(data, list):
            raise HTTPException(
                status_code=400,
                detail="Fixture file must contain a JSON array of transactions"
            )
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON: {e}")
    
    # Save file
    ensure_fixtures_dir()
    fixture_path = get_fixture_path(connector_id)
    
    with open(fixture_path, "wb") as f:
        f.write(content)
    
    # Update connector config
    config = connector.config or {}
    config["test_mode"] = True
    config["test_file_path"] = f"data/input/fixtures/{connector_id}.json"
    connector.config = config
    
    session.add(connector)
    session.commit()
    
    log.info(f"Uploaded fixture for connector {connector_id}: {len(data)} items")
    
    return FixtureUploadResponse(
        filename=fixture_path.name,
        path=str(fixture_path.relative_to(Path(__file__).parent.parent.parent)),
        size_bytes=len(content),
        item_count=len(data),
    )


@router.delete("/connectors/{connector_id}/test-fixture", status_code=204)
def delete_connector_fixture(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Delete a connector's test fixture and disable test mode.
    
    Args:
        connector_id: The connector ID whose fixture to delete
    """
    # Verify connector exists
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    # Delete the fixture file
    deleted = delete_fixture_file(connector_id)
    
    # Update connector config to disable test mode
    config = connector.config or {}
    config.pop("test_mode", None)
    config.pop("test_file_path", None)
    connector.config = config
    
    session.add(connector)
    session.commit()
    
    if not deleted:
        log.info(f"No fixture file existed for connector {connector_id}, but config was cleared")
    
    return None


@router.get("/connectors/{connector_id}/test-fixture")
def get_connector_fixture_status(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get the test fixture status for a connector.
    
    Returns:
        Information about the connector's test mode and fixture file
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    config = connector.config or {}
    fixture_path = get_fixture_path(connector_id)
    
    has_fixture = fixture_path.exists()
    item_count = None
    
    if has_fixture:
        try:
            with open(fixture_path, "r") as f:
                data = json.load(f)
                if isinstance(data, list):
                    item_count = len(data)
        except Exception:
            pass
    
    return {
        "connector_id": connector_id,
        "test_mode": config.get("test_mode", False),
        "test_file_path": config.get("test_file_path"),
        "has_fixture": has_fixture,
        "item_count": item_count,
        "fixture_size_bytes": fixture_path.stat().st_size if has_fixture else None,
    }


@router.get("/connectors/{connector_id}/test-fixture/content")
def get_connector_fixture_content(
    connector_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get the actual JSON content of a connector's test fixture file.
    
    Returns the parsed JSON array directly for preview purposes.
    """
    connector = session.get(AccountConnector, connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail=f"Connector {connector_id} not found")
    
    fixture_path = get_fixture_path(connector_id)
    if not fixture_path.exists():
        raise HTTPException(status_code=404, detail="No fixture file found")
    
    try:
        with open(fixture_path, "r") as f:
            data = json.load(f)
        return data
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON in fixture: {e}")
