# Backend Dockerfile
# Multi-stage build for optimized image
# Build context must be the repository root (not ./backend)

FROM python:3.11-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python packages
COPY backend/requirements.txt .
RUN pip install --user --no-cache-dir -r requirements.txt

# Production stage
FROM python:3.11-slim

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security (before copying packages)
RUN useradd --create-home --shell /bin/bash appuser

# Copy installed packages from builder into appuser's home so imports resolve
# when running as the non-root user
COPY --from=builder --chown=appuser:appuser /root/.local /home/appuser/.local

# Make sure scripts in .local are usable, and expose /app on the import path so
# the `backend` package (backend.api.main) is importable
ENV PATH=/home/appuser/.local/bin:$PATH
ENV PYTHONPATH=/app

# Copy backend application code as a package under /app/backend (repo-root context)
COPY --chown=appuser:appuser backend ./backend

USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8000/api/v1/health || exit 1

# Run with uvicorn (backend.api.main:app resolves via PYTHONPATH=/app + backend/)
CMD ["uvicorn", "backend.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
