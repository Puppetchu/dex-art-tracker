FROM node:22-alpine
WORKDIR /app
# package-lock.json fixes the version of every package (also the ones the libraries bring along), so every build
# installs exactly the same code: a new release of some package can no longer break a rebuild.
# npm picks the matching prebuilt builds for Alpine (x64 or arm64) here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js start.js ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data PORT=8080
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/status >/dev/null || exit 1
# start.js runs server.js and restarts it when settings are changed on the admin page
CMD ["node", "start.js"]
