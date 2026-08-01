FROM node:22-bookworm-slim

# mongodb-database-tools provides mongodump/mongorestore — the actual backup/restore
# engine (see docs/DECISIONS.md D3). Not available via apt, so fetch the .deb directly.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-100.10.0.deb -o /tmp/db-tools.deb \
  && apt-get install -y /tmp/db-tools.deb \
  && rm /tmp/db-tools.deb \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "src/server.js"]
