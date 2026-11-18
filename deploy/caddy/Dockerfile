FROM mirror.gcr.io/library/caddy:2.11.9-builder AS builder

RUN xcaddy build v2.11.9 \
    --with github.com/caddy-dns/route53@v1.6.3 \
    --output /usr/bin/caddy

FROM mirror.gcr.io/library/caddy:2.11.9-alpine

RUN apk upgrade --no-cache

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
