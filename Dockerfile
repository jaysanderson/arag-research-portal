FROM denoland/deno:2.9.5

WORKDIR /app

COPY deno.json ./
COPY packages ./packages
COPY apps ./apps

RUN deno cache apps/api/src/server.ts

EXPOSE 8787

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write=/app/data", "apps/api/src/server.ts"]
