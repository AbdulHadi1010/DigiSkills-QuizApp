# =============================================================================
# DigiQuiz dev bundle — web tier image (public tier)
#
# Build context is the BUNDLE ROOT:
#   docker build -f web-tier/Dockerfile .
#
# On AWS this tier is an EC2 instance in a public subnet behind the ALB,
# bootstrapped by wp7-deployment-runbook.md §6.2.
#
# The one dev deviation baked in here is `public/` — in the AWS build those
# three files live in a private S3 bucket behind CloudFront and this image would
# not contain them. SERVE_STATIC_DIR is what activates them; unset it and this
# tier serves exactly one page, /admin, as it does in production.
# =============================================================================

FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /opt/digiquiz

COPY web-tier/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY web-tier/web-server.js ./web-server.js
COPY web-tier/admin.html    ./admin.html
COPY web-tier/public        ./public

# BUILD-TIME GUARD — the central invariant of the whole project.
# The web tier must not be able to reach a database even in principle. If a
# database driver ever appears in its dependency tree, this build fails rather
# than shipping an image that quietly violates the architecture.
RUN for pkg in mysql mysql2 mariadb pg sqlite3 better-sqlite3 knex sequelize; do \
      if [ -d "node_modules/$pkg" ]; then \
        echo "FATAL: web tier must not depend on $pkg" >&2; exit 1; \
      fi; \
    done \
 && echo "ok: no database driver in the web tier" \
 && node -e "try{require('jsonwebtoken');console.error('FATAL: web tier must not hold a JWT library');process.exit(1)}catch(e){console.log('ok: no JWT library — this tier holds no signing key')}" \
 && node --check web-server.js

ENV NODE_ENV=production \
    PORT=8080

USER node

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "web-server.js"]
