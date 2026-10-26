# Chromium plus every system library Playwright needs, matching the pinned Playwright version.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

# Hosted defaults: Hugging Face Spaces expects port 7860 and places exactly one reverse proxy
# in front of the container, so the real client is the last X-Forwarded-For entry (TRUST_PROXY=1).
# Do not expose this container directly to the internet without turning TRUST_PROXY off.
# The Chromium sandbox stays on; the app falls back (and logs) only if the host cannot run it.
ENV NODE_ENV=production \
    PORT=7860 \
    TRUST_PROXY=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 7860
CMD ["node", "dist/main.js"]
