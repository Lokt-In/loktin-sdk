# The keeper image (E6, W105, W106). Both stages use the same base, pinned by
# digest; Dependabot proposes later digests. The first installs the
# production packages from the lockfile, the second copies only them and the
# source, and runs one pass as the non-root node user.
FROM node:26.12.0-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11 AS install
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev

FROM node:26.12.0-slim@sha256:e556a144463cc8dc53afe8de6d2fa0db5c132fd39ffa232c17641bd40df2bf11
ENV NODE_ENV=production
WORKDIR /app
COPY --from=install /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
ENTRYPOINT ["node", "src/run.ts"]
