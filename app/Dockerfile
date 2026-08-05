# --- build stage -------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.test.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime stage ------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Deploy stamp: the pipeline passes --build-arg GIT_SHA=$(git rev-parse HEAD)
# and --build-arg BUILD_TIME=$(date -u +%FT%TZ); /api/meta reports them and
# a new GIT_SHA appends a DeployRecorded event on boot. Unset args become
# empty strings, which the app treats the same as unset.
ARG GIT_SHA
ARG BUILD_TIME
ENV GIT_SHA=${GIT_SHA} BUILD_TIME=${BUILD_TIME}

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY package.json ./

# Event log lives here unless BLOG_EVENTS_PATH points elsewhere (mount a
# volume in real deployments; the Postgres store replaces this on ECS/RDS).
RUN mkdir -p var && chown -R node:node /app
USER node

# Content/themes are not baked into the image: mount them and set
# CONTENT_DIR/THEMES_DIR (defaults resolve to /content and /themes).
EXPOSE 3000
CMD ["node", "dist/main.js"]
