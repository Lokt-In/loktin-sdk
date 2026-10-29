# The keeper image (E6, W105, W106). Both stages use the same base, pinned by
# digest; Dependabot proposes later digests. The first installs the
# production packages from the lockfile, the second copies only them and the
# source, and runs one pass as the non-root node user.
FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS install
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
ENTRYPOINT ["node", "src/run.ts"]
