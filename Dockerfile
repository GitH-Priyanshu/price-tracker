# Use the official Microsoft Playwright image matching our Playwright dependency (v1.51.x)
# This includes all required system libraries, fonts, and containerized Chromium dependencies.
FROM mcr.microsoft.com/playwright:v1.51.0-jammy

# Set container working directory
WORKDIR /app

# Set production environment flags
ENV NODE_ENV=production
ENV PORT=10000
ENV SCRAPE_CONCURRENCY=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy workspace package definitions and lockfiles first for optimal layer caching
COPY package*.json ./
COPY server/package*.json ./server/

# Install production dependencies only (never copy local node_modules)
RUN npm ci --workspace=server --omit=dev

# Copy application source code (note: .dockerignore strictly excludes .env and node_modules)
COPY server ./server

# Expose dynamic application port for Render / cloud container runtime
EXPOSE 10000

# Start server with node directly (handles SIGTERM and signals natively)
CMD ["node", "server/src/index.js"]
