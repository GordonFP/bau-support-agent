# Compile first with the frozen host toolchain: npm run build.
# Linux installs the exact production lock selection; no host npm config is copied.
FROM node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --userconfig=/dev/null \
    && npm cache clean --force

FROM node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY dist/src/adapters ./dist/src/adapters
COPY dist/src/troubleshooting ./dist/src/troubleshooting
COPY dist/src/bootstrap ./dist/src/bootstrap
COPY runtime-skills/bau-troubleshooting/SKILL.md ./runtime-skills/bau-troubleshooting/SKILL.md
COPY deployment/runtime.example.json /etc/bau/runtime.json
COPY notices ./notices
RUN mkdir -p /var/lib/bau/records && chown 1000:1000 /var/lib/bau/records && chmod 0700 /var/lib/bau/records
USER 1000:1000
ENV NODE_ENV=production OPENAI_LOG=off
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/src/bootstrap/main.js"]
