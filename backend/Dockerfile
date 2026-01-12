# Backend Dockerfile
# Multi-stage build for optimized image
# Build context should be repository root (not ./backend)

FROM python:3.13-slim as builder

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
FROM python:3.13-slim

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security (before copying packages)
RUN useradd --create-home --shell /bin/bash appuser

# Copy installed packages from builder and set ownership
COPY --from=builder --chown=appuser:appuser /root/.local /home/appuser/.local

# Make sure scripts in .local are usable
ENV PATH=/home/appuser/.local/bin:$PATH
ENV PYTHONPATH=/app

# Copy backend application code (from repo root context)
COPY --chown=appuser:appuser backend ./backend

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Health check - use curl instead of python for lighter healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8000/api/v1/health || exit 1

# Run with uvicorn (now backend.api.main:app works because PYTHONPATH=/app and backend/ is a subdirectory)
CMD ["uvicorn", "backend.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
