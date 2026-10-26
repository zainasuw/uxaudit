# Chromium plus every system library Playwright needs, matching the pinned Playwright version.
FROM mcr.microsoft.com/playwright:v1.58.2-noble

ENV NODE_ENV=production \
    PORT=10000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev && chown -R pwuser:pwuser /app

USER pwuser
EXPOSE 10000
CMD ["node", "dist/main.js"]
