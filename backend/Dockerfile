# The API image (P7.1): a small multi-stage Node 22 build.
#
#   build    every dependency, then `tsc` compiles src/ into dist/;
#   runtime  production dependencies and dist/ only, run as the image's
#            unprivileged `node` user: `node dist/main.js`.
#
# No secret is baked in. Configuration arrives at run time as environment
# variables (infra/compose.yaml); .dockerignore keeps every .env file out of
# the build context; migrations are applied deliberately from a checkout,
# never by this image (drizzle.config.ts). Install scripts are skipped: no
# dependency needs one to build or run (the lockfile's only install scripts
# belong to dev tools this build does not use).
#
# The base image is pinned by digest, as the LiveKit image is, so a rebuild
# gets exactly this Node 22; the tag beside it is for the reader.
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
# The strictest environment unless told otherwise: started without NODE_ENV,
# the API refuses placeholder secrets instead of running as development.
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# The one path the process writes: stored files (STORAGE_LOCAL_ROOT), a volume in compose.
RUN mkdir .storage && chown node:node .storage
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
