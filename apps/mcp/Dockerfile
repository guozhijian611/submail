FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci --workspace apps/mcp --include-workspace-root

FROM deps AS build
COPY apps/mcp apps/mcp
RUN npm --workspace apps/mcp run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY apps/mcp/package.json apps/mcp/package.json
RUN npm ci --workspace apps/mcp --omit=dev --include-workspace-root \
  && chown -R node:node /app
COPY --chown=node:node --from=build /app/apps/mcp/dist apps/mcp/dist
USER node
EXPOSE 3000
CMD ["node", "apps/mcp/dist/index.js"]
