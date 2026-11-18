# Caddy HTTPS with AWS Route 53

This optional overlay terminates TLS in Caddy and forwards requests to the
existing Monize frontend. The backend stays private. It builds Caddy with the
Route 53 DNS plugin; the standard Caddy image does not include that plugin.
The production stack without the overlay is unchanged.

## Prerequisites

- Docker Compose 2.24.4 or newer, with support for `!reset`.
- An existing production deployment configured with
  [docker-compose.prod.yml](../../docker-compose.prod.yml).
- A **public** Route 53 hosted zone for the domain. A private hosted zone cannot
  validate a publicly trusted certificate, even when Monize is LAN-only.
- TCP ports 80 and 443 available on the Docker host. UDP 443 enables HTTP/3.
- Outbound access to AWS, ACME certificate authorities, and public DNS resolvers
  (1.1.1.1 and 8.8.8.8). Those resolvers let Caddy check public TXT records even
  when the LAN has a private DNS override for the app's hostname.

The examples use `money.example.com` in the reserved `example.com` zone;
substitute a domain you control in the DNS instructions, IAM policy and settings.

DNS validation does not require inbound Internet access. For `money.example.com`,
configure your LAN DNS to resolve that name to the Docker host's LAN IP. No
public A/AAAA record or router port forwarding is required. Caddy creates and
removes `_acme-challenge.money.example.com` TXT records in the public `example.com`
zone. Public certificates disclose their names in Certificate Transparency logs.

## Route 53 permissions

Create a dedicated IAM principal, not root credentials or an administrator key.
Attach the following policy, substituting the public hosted zone ID for
`YOUR_PUBLIC_ZONE_ID`. If using another hostname, also change the challenge
record name. Discovery can list zones; record writes are restricted by IAM to
one TXT name in one hosted zone.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["route53:ListHostedZones", "route53:ListHostedZonesByName"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "route53:ListResourceRecordSets",
      "Resource": "arn:aws:route53:::hostedzone/YOUR_PUBLIC_ZONE_ID"
    },
    {
      "Effect": "Allow",
      "Action": "route53:GetChange",
      "Resource": "arn:aws:route53:::change/*"
    },
    {
      "Effect": "Allow",
      "Action": "route53:ChangeResourceRecordSets",
      "Resource": "arn:aws:route53:::hostedzone/YOUR_PUBLIC_ZONE_ID",
      "Condition": {
        "ForAllValues:StringEquals": {
          "route53:ChangeResourceRecordSetsRecordTypes": ["TXT"],
          "route53:ChangeResourceRecordSetsNormalizedRecordNames": [
            "_acme-challenge.money.example.com"
          ]
        }
      }
    }
  ]
}
```

## Configure and deploy

In the deployment's existing `.env`, add the following values. Keep its database,
JWT, encryption and other application settings unchanged.

```dotenv
CADDY_DOMAIN=money.example.com
CADDY_ROUTE53_HOSTED_ZONE_ID=YOUR_PUBLIC_ZONE_ID
CADDY_AWS_ACCESS_KEY_ID=YOUR_DEDICATED_ACCESS_KEY
CADDY_AWS_SECRET_ACCESS_KEY=YOUR_DEDICATED_SECRET
CADDY_AWS_REGION=us-east-1
```

Use the bare hostname for `CADDY_DOMAIN`, without a scheme, port or path. The
overlay sets `PUBLIC_APP_URL` and `CORS_ORIGIN` to `https://money.example.com`
inside both relevant services and forces HTTPS headers and secure cookies on.
One trusted proxy hop matches Caddy's forwarded client address; the frontend
does not trust an arbitrary client-supplied `X-Real-IP`.

Credentials are supplied at runtime, not copied into the image. Protect `.env`
and do not commit it or share the output of `docker compose config`, which
contains resolved credentials. For temporary AWS credentials, also set
`CADDY_AWS_SESSION_TOKEN`; replace all three credentials and recreate Caddy
before they expire. Keep credentials valid for unattended certificate renewal.

From the repository root, validate without printing resolved secrets, then deploy:

```sh
docker compose -f docker-compose.prod.yml -f docker-compose.caddy.yml config --quiet
docker compose -f docker-compose.prod.yml -f docker-compose.caddy.yml up -d --build
docker compose -f docker-compose.prod.yml -f docker-compose.caddy.yml logs --tail=100 caddy
```

Use **both** Compose files for subsequent updates, restarts and shutdowns. The
overlay removes the frontend's published HTTP port with `!reset []`; publishing
it alongside Caddy would allow direct access around TLS termination.

Open `https://money.example.com` after certificate issuance succeeds. HTTP on port
80 redirects to HTTPS. For an OIDC deployment, update the provider's registered
callback URL and `OIDC_CALLBACK_URL` to the new HTTPS origin.

## Persistence and troubleshooting

The `caddy_data` volume holds certificate private keys, ACME account state and
renewed certificates; `caddy_config` holds Caddy's saved configuration. Keep them
across rebuilds and restarts, protect their contents, and do not use
`docker compose down -v`. Caddy obtains and renews certificates through ACME
using the Route 53 credentials; a normal renewal needs no Monize restart.

If issuance fails, inspect the Caddy logs for IAM refusal, an incorrect public
zone ID, expired credentials, DNS propagation, or outbound connectivity failures.
Check any CAA records allow the certificate authority Caddy is using. If the
browser cannot reach the site, check LAN DNS, stale AAAA records and the host
firewall. No certificate is issued merely by building the image.

The focused configuration tests use fake credentials and do not start services,
contact Route 53, or request certificates:

```sh
node --test scripts/caddy-compose.test.mjs
```
