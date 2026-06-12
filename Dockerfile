# Beer POS Pro - Dockerfile
FROM node:18-alpine

# Install security updates and required tools
RUN apk add --no-cache dumb-init tini

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production --ignore-scripts

# Copy application code
COPY server.js ./
COPY database.js ./
COPY ecosystem.config.js ./
COPY database ./database/
COPY middleware ./middleware/
COPY routes ./routes/
COPY src ./src/
COPY views ./views/
COPY public ./public/
COPY node_modules/better-sqlite3 ./node_modules/better-sqlite3/
COPY node_modules/bindings ./node_modules/bindings/ 2>/dev/null || true
COPY node_modules/file-uri-to-path ./node_modules/file-uri-to-path/ 2>/dev/null || true

# Rebuild better-sqlite3 native bindings for alpine
RUN apk add --no-cache python3 make g++ && \
    npm rebuild better-sqlite3 --build-from-source && \
    apk del python3 make g++

# Create data directory for SQLite database
RUN mkdir -p /app/data && chmod 755 /app/data

# Create logs directory
RUN mkdir -p /app/logs && chmod 755 /app/logs

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Use PM2 for process management with auto-restart
CMD ["pm2-runtime", "ecosystem.config.js"]
