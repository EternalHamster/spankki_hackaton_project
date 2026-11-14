FROM node:24-bookworm-slim AS nodebin
FROM python:3.12-slim-bookworm AS base
COPY --from=nodebin /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/requirements.txt /tmp/runtime-requirements.txt
RUN pip install --no-cache-dir -r /tmp/runtime-requirements.txt && useradd --uid 10001 --create-home coach
ENV PYTHONUNBUFFERED=1 PYTHONUTF8=1 COACH_CODE_ROOT=/app COACH_DB_PATH=/app/BDA/output/coach.duckdb

FROM base AS verify
COPY package.json server.mjs chat.mjs coach.mjs coach-memory.mjs coach-projects.mjs prepared.mjs customers.mjs data-source.mjs spending-highlights.mjs spending-patterns.mjs saving-actions.mjs ./
COPY .runtime/ ./
COPY runtime/worker.py ./runtime/worker.py
COPY server-data/ ./server-data/
COPY public/ ./public/
COPY scripts/check.mjs scripts/check-prepared.mjs scripts/prepare-coach.mjs ./scripts/
COPY tests/ ./tests/
RUN node scripts/check.mjs
RUN node scripts/check-prepared.mjs

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
COPY --from=verify --chown=coach:coach /app/package.json /app/server.mjs /app/chat.mjs /app/coach.mjs /app/coach-memory.mjs /app/coach-projects.mjs /app/prepared.mjs /app/customers.mjs /app/data-source.mjs /app/spending-highlights.mjs /app/spending-patterns.mjs /app/saving-actions.mjs ./
COPY --from=verify --chown=coach:coach /app/BDA/ ./BDA/
COPY --from=verify --chown=coach:coach /app/coach_context/ ./coach_context/
COPY --from=verify --chown=coach:coach /app/runtime/ ./runtime/
COPY --from=verify --chown=coach:coach /app/server-data/wrapped-data.json ./server-data/wrapped-data.json
COPY --from=verify --chown=coach:coach /app/server-data/coach-answers.json ./server-data/coach-answers.json
COPY --from=verify --chown=coach:coach /app/public/ ./public/
USER coach
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
