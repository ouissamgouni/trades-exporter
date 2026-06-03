---
applyTo: "backend/**"
---

# Backend change rules

Reference patterns: [backend/api/routes/events.py](backend/api/routes/events.py) + [backend/tests/api/test_routes.py](backend/tests/api/test_routes.py).

## Don't
- Don't add features, refactors, comments, docstrings, or type hints beyond what the change requires.
- Don't reformat unrelated lines (keeps diffs reviewable).
- Don't catch `Exception` broadly to silence errors — handle specifically or let it bubble.
- Don't use `print()` — use the existing module logger.
- Don't truncate, drop, or migrate data destructively without explicit user confirmation.
- Don't edit migrations already merged to `develop`/`main` or applied to staging/prod (local unmerged migrations are OK to amend).
- Don't commit secrets; new env vars go in `config/base.env` + `*.env.example` with safe defaults.
- Don't open ad-hoc DB sessions — use the existing `Depends(get_session)` pattern.
- Don't remove existing internal validation just because "validate at boundaries" says so.

## Tests (minimal but real)
- Add/update **only major or critical** tests. Concretely:
  - **Test**: a new branch in business logic, a new route's happy path + 1 error path, a bug fix (regression test).
  - **Skip**: trivial getters, pass-through wrappers, schema field renames already covered by Pydantic, framework behavior.
- Prefer updating an existing test file over creating a new one.
- After any **behavior** change, run the full backend suite before reporting done: `task test:backend` (or `.venv/bin/pytest -q` from `backend/`). Skip for pure docs/typo fixes.
- If a test fails, fix the cause — don't weaken assertions or add `skip` to make it green.

## API contract
- Pydantic schemas in [backend/api/schemas.py](backend/api/schemas.py) are the contract with the frontend. Breaking changes (renamed/removed fields, type changes) require checking [frontend/src/types.ts](frontend/src/types.ts) and [frontend/src/api.ts](frontend/src/api.ts) in the same change.

## Performance
- Watch for N+1 queries when adding loops over related objects — use `selectinload`/joins.
- Long-running work belongs in the existing scheduler/worker services, not in request handlers.
