# Chromium plus every system library Playwright needs, matching the pinned Playwright version.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

# Hosted defaults: Hugging Face Spaces expects port 7860 and runs behind a proxy;
# containers cannot use Chromium's user-namespace sandbox, so the container is the boundary.
ENV NODE_ENV=production \
    PORT=7860 \
    TRUST_PROXY=1 \
    CHROMIUM_SANDBOX=0 \
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
