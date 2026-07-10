FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace apps/api --include-workspace-root

FROM deps AS build
COPY apps/api apps/api
RUN npm --workspace apps/api run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/package.json
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm ci --workspace apps/api --omit=dev --include-workspace-root \
  && apk del .build-deps \
  && mkdir -p /data /storage \
  && chown -R node:node /app /data /storage
COPY --chown=node:node --from=build /app/apps/api/dist apps/api/dist
USER node
EXPOSE 8787
CMD ["node", "apps/api/dist/server.js"]
