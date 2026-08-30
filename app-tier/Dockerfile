# =============================================================================
# DigiQuiz dev bundle — app tier image (private application tier)
#
# Build context is the BUNDLE ROOT, not this directory:
#   docker build -f app-tier/Dockerfile .
# which is what docker-compose.yml does.
#
# On AWS this tier is an EC2 instance in a private subnet, bootstrapped by the
# user-data script in wp7-deployment-runbook.md §5.2. The layout here mirrors
# that script: code in /opt/digiquiz, running as an unprivileged user, started
# by an init system that restarts it on failure (systemd there, Docker here).
# =============================================================================

FROM node:22-alpine

# tini gives us correct signal handling, so SIGTERM reaches Node and the
# graceful-shutdown path in app-server.js actually runs (matters because the
# app drains its connection pool on the way out).
RUN apk add --no-cache tini

WORKDIR /opt/digiquiz

# Dependencies first, so a code edit does not invalidate the npm layer.
COPY app-tier/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Application code
COPY app-tier/app-server.js ./app-server.js
COPY app-tier/db.js         ./db.js

# The seed file is only used by the SQLite branch of db.js. In this image
# DB_ENGINE=mysql, and MySQL is seeded by docker-compose mounting digiquiz.sql
# into /docker-entrypoint-initdb.d on the db service. Copied anyway so the same
# image can be run with DB_ENGINE=sqlite for a quick smoke test.
COPY sql/digiquiz.sqlite.sql ./sql/digiquiz.sqlite.sql

# Sanity check at BUILD time: the app tier must have a real MySQL driver.
RUN node -e "require('mysql2/promise'); console.log('ok: mysql2 present')" \
 && node --check app-server.js \
 && node --check db.js

ENV NODE_ENV=production \
    PORT=4000 \
    DB_ENGINE=mysql

# Never run as root. `node` is a non-root user that the base image provides.
USER node

EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app-server.js"]
