FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_FILE=/data/installations.json PORT=3000
COPY package.json ./
COPY src ./src
# the store file holds secrets: it lives on a volume, owned by the non-root user
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/main.mjs"]
