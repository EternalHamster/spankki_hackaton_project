# Both stages use Node 24 LTS. Rebuild regularly to receive base-image updates.
FROM node:24-alpine AS verify
WORKDIR /app
COPY package.json server.mjs chat.mjs ./
COPY public/ ./public/
COPY scripts/check.mjs ./scripts/check.mjs
COPY tests/ ./tests/
RUN node scripts/check.mjs

FROM node:24-alpine AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=verify --chown=node:node /app/package.json /app/server.mjs /app/chat.mjs ./
COPY --from=verify --chown=node:node /app/public/ ./public/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
