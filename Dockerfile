# Container image for the API + dashboard as ONE service.
#
# Works anywhere that runs a container: Koyeb, Fly, Railway, Render, or plain
# Docker on a VPS. Written so the platform choice stays reversible — nothing
# in here is specific to one host.
#
# TWO STAGES, AND THE REASON MATTERS
# The client build needs devDependencies (Vite, Tailwind) and produces static
# files. The server needs neither. Building in a throwaway stage and copying
# only client/dist forward keeps the toolchain out of the running image —
# smaller, and a smaller attack surface on a box that talks to the public
# internet.

# ---------------------------------------------------------------- client ---
FROM node:22-slim AS client

WORKDIR /build

# Manifests first. Layer caching keys on these, so `npm ci` is only re-run
# when dependencies actually change rather than on every source edit — the
# difference between a 20-second and a 3-minute deploy.
COPY client/package*.json ./client/
RUN npm --prefix client ci --no-audit --no-fund

COPY client/ ./client/

# VITE_* are inlined at BUILD time, not read at runtime. They must be present
# here or the dashboard ships with sign-in silently disabled and no error
# until someone tries to log in. The platform supplies them as build args.
#
# NOT SECRETS: the anon key is designed to be public and appears in the
# browser bundle regardless. The service-role key must never be passed here.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

RUN npm --prefix client run build

# ---------------------------------------------------------------- runtime --
FROM node:22-slim AS runtime

# tini as PID 1. Node does not reap zombies or forward signals the way an init
# system does, and without it SIGTERM on redeploy never reaches the app —
# the WhatsApp socket is killed rather than closed, and the platform waits out
# its full grace period on every deploy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
# --omit=dev: the server's own devDependencies are test tooling. Nothing in
# the request path imports them.
RUN npm ci --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY scripts/ ./scripts/
COPY db/ ./db/

# Only the built output crosses from the client stage.
COPY --from=client /build/client/dist ./client/dist

# Run as the image's own unprivileged user. Baileys keeps its auth state in
# Postgres rather than on disk, so nothing here needs to write to the
# filesystem at runtime.
USER node

# The app reads PORT; most platforms inject their own. 4000 matches the
# default in server/config/env.js so local `docker run` needs no flags.
ENV PORT=4000
EXPOSE 4000

# Container-level health, distinct from the platform's HTTP check: this one
# also fails when the process is up but the database is unreachable, which is
# the state that looks healthy from outside and answers nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
