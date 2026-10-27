# Chromium plus every system library Playwright needs, matching the pinned Playwright version.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

# Keep this tag equal to the playwright version in package.json.
# Defaults: port 7860 (what Hugging Face Spaces expect). TRUST_PROXY is off, so client addresses
# come from the connection itself and cannot be chosen by the client. Behind a reverse proxy that
# means every visitor shares the proxy's address, so the per-visitor limits apply to the whole site;
# set TRUST_PROXY=1 only when exactly one reverse proxy sits in front and appends the real client
# to X-Forwarded-For (on a Docker Space, as a Space variable).
# The Chromium sandbox stays on; the app falls back (and logs) only if the host cannot run it.
ENV NODE_ENV=production \
    PORT=7860 \
    TRUST_PROXY=0 \
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
