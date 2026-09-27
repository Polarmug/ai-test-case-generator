# One container: builds the React frontend, runs the Express backend, and has Bob Shell installed.
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates bash \
 && rm -rf /var/lib/apt/lists/*

# Install IBM Bob Shell (global npm package) with the official installer.
RUN curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash -s -- --pm npm \
 && bob --version

WORKDIR /app

COPY frontend/package*.json frontend/
RUN cd frontend && npm ci
COPY frontend/ frontend/
RUN cd frontend && npm run build

COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ backend/

ENV NODE_ENV=production
WORKDIR /app/backend
CMD ["node", "server.js"]
