# The keeper image (E6, W105, W106). Both stages use the same base, pinned by
# digest; Dependabot proposes later digests. The first installs the
# production packages from the lockfile, the second copies only them and the
# source, and runs one pass as the non-root node user.
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS install
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
ENTRYPOINT ["node", "src/run.ts"]
