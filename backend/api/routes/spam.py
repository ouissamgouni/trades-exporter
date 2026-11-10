"""Suspected-spam review: per-token verdicts and inbox count."""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from backend.api.schemas import (
    SpamSummaryResponse,
    SpamVerdictRequest,
    SpamVerdictResponse,
)
from backend.db.database import get_session_dependency
from backend.services.spam_heuristic_service import (
    apply_token_verdict,
    apply_transaction_verdict,
    count_suspected,
)

router = APIRouter(prefix="/spam", tags=["spam"])


@router.get("/summary", response_model=SpamSummaryResponse)
def get_spam_summary(session: Session = Depends(get_session_dependency)):
    return SpamSummaryResponse(suspected_count=count_suspected(session))


@router.post("/verdict", response_model=SpamVerdictResponse)
def post_spam_verdict(
    body: SpamVerdictRequest,
    session: Session = Depends(get_session_dependency),
):
    try:
        if body.scope == "transaction":
            ids = body.transaction_ids or (
                [body.transaction_id] if body.transaction_id is not None else []
            )
            result = apply_transaction_verdict(session, ids, body.verdict)
        else:
            if body.transaction_id is None:
                raise ValueError("transaction_id is required for a token verdict")
            result = apply_token_verdict(session, body.transaction_id, body.verdict)
        return SpamVerdictResponse(**result)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
