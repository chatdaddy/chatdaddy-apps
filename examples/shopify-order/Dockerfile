FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_FILE=/data/installations.json PORT=3000
COPY package.json ./
COPY src ./src
COPY docker-entrypoint.sh ./
# the store file holds secrets: it lives on a volume. The entrypoint chowns it, then drops to the non-root `node` user
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
