FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/status >/dev/null || exit 1
CMD ["node", "server.js"]
