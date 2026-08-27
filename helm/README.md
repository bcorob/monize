# Monize Helm Chart

A Helm chart for deploying the Monize personal finance application on Kubernetes.

## Architecture

Monize is a two-tier application:
- **Backend**: Node.js API server (port 3001) connected to a PostgreSQL database
- **Frontend**: Web application (port 3000) that communicates with the backend internally

Only the frontend is exposed externally via HTTPRoute or Ingress. The backend is accessible only within the cluster.

## Prerequisites

- Kubernetes 1.27+
- Helm 3.x
- Either a Gateway API implementation (e.g., Cilium) **or** an Ingress controller

## Installation

```bash
# Install with default values (HTTPRoute enabled)
helm install monize ./helm -n monize --create-namespace

# Install with Ingress instead of HTTPRoute
helm install monize ./helm -n monize --create-namespace \
  --set httpRoute.enabled=false \
  --set ingress.enabled=true \
  --set ingress.className=nginx

# Dry-run to preview rendered templates
helm template monize ./helm -n monize
```

## Routing Options

This chart supports two mutually exclusive routing strategies:

### HTTPRoute (Gateway API) - Default

Enabled by default. Uses the Kubernetes Gateway API with a Cilium TLS gateway.

```yaml
httpRoute:
  enabled: true
  parentRefs:
    - name: tls
      namespace: cilium
      sectionName: https
```

### Ingress (Traditional)

For clusters using a traditional Ingress controller (nginx, traefik, etc.):

```yaml
httpRoute:
  enabled: false

ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
  tls:
    - secretName: monize-tls
      hosts:
        - monize.yourdomain.com
```

> **Note**: Both can technically be enabled simultaneously, but it is recommended to only enable one.

## Configuration

### Global Settings

| Parameter | Description | Default |
|-----------|-------------|---------|
| `global.namespace` | Namespace for all resources | `monize` |
| `global.domain` | Application domain | `yourdomain.com` |
| `global.hostname` | Full hostname override | `monize.<domain>` |
| `global.timezone` | Container timezone | `America/Toronto` |
| `global.priorityClassName` | Pod priority class | `low-priority` |

### Namespace

| Parameter | Description | Default |
|-----------|-------------|---------|
| `namespace.create` | Create the namespace | `true` |
| `namespace.podSecurityEnforce` | Pod Security Standard level | `restricted` |

### Backend

| Parameter | Description | Default |
|-----------|-------------|---------|
| `backend.image.registry` | Image registry | `ghcr.io` |
| `backend.image.repository` | Image repository | `kenlasko/monize/backend` |
| `backend.image.tag` | Image tag | `latest` |
| `backend.image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `backend.replicas` | Number of replicas | `1` |
| `backend.service.port` | Service port | `3001` |
| `backend.service.type` | Service type | `ClusterIP` |
| `backend.resources` | CPU/memory requests and limits | See values.yaml |
| `backend.securityContext` | Container security context | Restricted (non-root, read-only fs) |
| `backend.livenessProbe` | Liveness probe config | `/api/v1/health/live` |
| `backend.readinessProbe` | Readiness probe config | `/api/v1/health/ready` |
| `backend.env.*` | Backend environment variables | See values.yaml |
| `backend.mnyImport.MNY_IMPORT_LIMIT_MB` | Largest Microsoft Money (.mny) file the import wizard accepts | `300` |
| `backend.backupLimits.exportBuffer` | JSON a buffered export may accumulate | derived from the memory limit |
| `backend.backupLimits.restoreExpanded` | Decompressed size a restore payload may reach | derived from the memory limit |
| `backend.backupLimits.restoreUpload` | Compressed upload the restore endpoint accepts | derived from the memory limit |
| `backend.restoreQueue.limit` | Restores that may wait for a processing slot before a 503 | `4` |
| `backend.restoreQueue.waitMs` | Milliseconds a restore may wait for a processing slot | `120000` |

> **`latest` with `IfNotPresent` does not pick up new builds.** The two defaults
> combine into a deployment that keeps whatever image the node already cached: a
> rolling restart re-uses it, so replicas can end up running different builds of
> the same tag. Pin an immutable tag or a digest (`--set
> backend.image.tag=v1.13.0`) for anything you intend to upgrade predictably, or
> set `pullPolicy=Always` if you genuinely want to track `latest`. This is
> stated rather than changed because flipping either default silently alters
> upgrade behaviour for existing installs.

#### Memory for Microsoft Money imports

The default `backend.resources.limits.memory` of `400Mi` is sized for ordinary
use and **cannot import a real `.mny` file** at the default
`MNY_IMPORT_LIMIT_MB`. A Money upload is buffered in
memory and decrypted in place, so peak usage is roughly twice the file size on
top of the baseline. A pod that hits its limit mid-import is OOM-killed, and the
wizard reports the job as stalled rather than as out of memory.

Set the limit to at least `2 x MNY_IMPORT_LIMIT_MB + 200Mi`:

| `MNY_IMPORT_LIMIT_MB` | Suggested `backend.resources.limits.memory` |
|---|---|
| `50` | `300Mi` |
| `100` | `400Mi` |
| `300` (default) | `1Gi` |

Lowering `MNY_IMPORT_LIMIT_MB` is the cheaper option when the files being
imported are small: the wizard then rejects an oversized file with a clear
message before any memory is committed to it.

#### Memory for backups and restores

Three backup paths cannot stream, so each holds a whole payload in memory: the
encrypted export and the automatic export (AES-GCM needs the entire plaintext to
compute its auth tag), the support export (it needs every table at once to
reconcile scaled balances), and a restore (it must decompress and parse the file
before it can validate it).

Each of those holds **several copies at peak** — per-table JSON strings, the
concatenated buffer, the gzip output, the parsed object graph — so a ceiling has
to be a fraction of `resources.limits.memory`, not close to it. A ceiling larger
than the container's limit is not a ceiling at all: the pod is OOM-killed before
the request can be refused, which leaves no artifact and no error the user can
read, only a restart.

That is not hypothetical. These defaulted to `1024mb` and `512mb` against this
chart's `400Mi` backend, so neither could ever fire.

Leave `backend.backupLimits` empty and the backend derives each ceiling from the
container's cgroup memory limit, which tracks whatever you set above. Set them when
you have measured your own deployment — the backend logs a warning at startup when
a configured value is too large to protect the process it is running in.

`exportBuffer` is roughly a quarter of the limit:

| `backend.resources.limits.memory` | Derived ceiling per buffered export |
|---|---|
| `256Mi` | `64Mi` (the floor) |
| `400Mi` (default) | `100Mi` |
| `1Gi` | `256Mi` |
| `4Gi` | `1Gi` (the cap) |

**The restore ceilings are smaller, and they are measured rather than assumed.**
Measured (issue #1073), a restore's peak memory is about **6.1× its expanded payload
plus a fixed 78Mi** — the fixed part being zlib's windows and the heap V8 grows to
parse and rewrite a document at all. The model previously assumed three times the
payload and no fixed part, which admitted restores the process could not finish. So
`restoreExpanded` is solved out of what the container has left rather than taken as a
share of it: the limit, minus the ordinary process baseline (`max(140Mi, a fifth)`),
less a 15% margin, minus the fixed cost, divided by 6.1. `restoreUpload` follows it,
because gzip output is never smaller than what it expands to.

| `backend.resources.limits.memory` | Largest restorable artifact | Concurrent restores |
|---|---|---|
| `200Mi` and below | none — restores refused with a 503 | 0 |
| `256Mi` | ~3Mi | 1 |
| `400Mi` (default) | ~23Mi | 1 |
| `1Gi` | ~101Mi | 1 |
| `8Gi` | ~903Mi | 1 |

**A pod that leaves less than about 78Mi free after the baseline cannot restore at
all**, however small the backup, because the fixed cost is spent before the first
byte of payload. That is a refusal with a message naming the lever, not an OOM kill
mid-restore.

A bigger pod otherwise buys a bigger artifact rather than a second concurrent
restore. If you would rather have concurrency, set `restoreExpanded` lower yourself —
though each concurrent restore pays the fixed 78Mi again, so the slot count grows
more slowly than the ceiling shrinks. And if a real backup is being refused, raise
`resources.limits.memory`: raising `restoreUpload` alone gets you an OOM-killed pod
instead of a refusal, which is the failure the ceiling exists to prevent.

A user whose dataset exceeds the ceiling gets a readable refusal naming the size
and the limit. For the support export they can also narrow it with an account
selection or a date range. If real exports are being refused, raise the memory
limit **and** the ceiling: raising either alone achieves nothing.

**A restore upload needs a ticket, and the ingress should have a body limit.**
The backend's upload admission has to run in front of its body parser, which is in
front of every guard — so it cannot authenticate the request whose memory it is
budgeting for. Since Monize 1.16 it does not have to: the client first asks
`POST /api/v1/backup/restore/ticket` (ordinary authenticated JSON) for a short-lived
signed ticket, and an upload without one is refused `403` before a byte is buffered.
Nothing to configure — it is on whenever `JWT_SECRET` is set, which is always.

What the chart cannot do for you is stop that traffic before it reaches the pod. If
you terminate with an Ingress, set a body-size limit on it to match your
`backupLimits.restoreUpload` (nginx: `nginx.ingress.kubernetes.io/proxy-body-size`;
Traefik: a `buffering` middleware with `maxRequestBodyBytes`) through
`ingress.annotations`. The default path in this chart is an HTTPRoute, and the Gateway
API has no portable request-body limit — so on that path the process's own admission
gate is the only limit, which is why it exists. Rate-limiting the restore path at the
edge is worth doing for the same reason.

**Restores queue, and the queue is bounded.** The compressed upload budget cannot
bound decompressed memory — a small gzip expands to the expanded ceiling whatever
its wire size — so restore *processing* is capped separately, at one concurrent
restore on the default pod. A second restore waits rather than decompressing
beside the first, because the caller has already uploaded the artifact and a 503
would make them upload it again. `backend.restoreQueue` bounds that wait in both
directions: past `limit` waiters a request is refused with 503 and `Retry-After`
instead of joining the queue, and past `waitMs` a waiting request is refused the
same way. A caller who disconnects while queued is dropped, and its restore never
runs — the operation is destructive, so running it for somebody who left is worse
than refusing it. A disconnect *after* the slot is granted changes nothing: that
restore is part-way through replacing the user's data and runs to completion. The
startup log prints the slot count with both bounds beside it.

**The frontend needs headroom too.** Every `/api/*` call is forwarded by the
Next.js proxy, which buffers the request body before sending it on, so a `.mny`
upload is held in the frontend container as well as the backend. Set
`frontend.resources.limits.memory` to at least `MNY_IMPORT_LIMIT_MB` plus its
`100Mi` baseline — so `400Mi` at the default 300.

Set `MNY_IMPORT_LIMIT_MB` on **both** deployments if you change it. The frontend
reads it to size the proxy's own body ceiling (Next caps proxied bodies at 10MB
otherwise, and truncates rather than rejecting anything larger).


#### Storage for data kept outside Postgres

The backend container runs with `readOnlyRootFilesystem: true`, so it can only
write where a volume is mounted. Until this block existed the StatefulSet
rendered no volumes at all, which meant two features visible in the UI could not
work in the canonical chart -- and both failed at the point of use rather than at
install time, so the UI went on presenting them as configured:

- **Automatic backups** write to `/data/backups`. Directory creation failed with
  EROFS, so a user's schedule reported errors forever and produced no files.
- **`ATTACHMENT_STORAGE_PROVIDER=local`** writes to `/data/attachments`. Same
  failure, for receipts and documents. (The default `database` provider keeps
  bytes in Postgres and is unaffected; so is `s3`.)

Both are off by default, because enabling them creates a PersistentVolumeClaim
and a cluster with no default StorageClass would leave the pod `Pending`. Turning
one on without saying where the storage comes from fails at render time rather
than at run time.

```yaml
backend:
  persistence:
    backups:
      enabled: true
      size: 5Gi           # or: existingClaim: my-backup-claim
      storageClass: ""    # empty uses the cluster default
      accessMode: ReadWriteOnce
    attachments:
      enabled: true       # only needed with ATTACHMENT_STORAGE_PROVIDER=local
      size: 10Gi
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `backend.persistence.backups.enabled` | Mount durable storage at `backupContainerDir` | `false` |
| `backend.persistence.backups.existingClaim` | Use an existing PVC instead of creating one | `""` |
| `backend.persistence.backups.size` | Size of the created claim | `5Gi` |
| `backend.persistence.backups.storageClass` | StorageClass (empty = cluster default) | `""` |
| `backend.persistence.attachments.*` | Same shape, for `/data/attachments` | disabled |
| `backend.backupContainerDir` | Mount path for backups | `/data/backups` |
| `backend.attachmentContainerDir` | Mount path for local attachments | `/data/attachments` |
| `backend.extraVolumes` / `extraVolumeMounts` | Anything else the pod needs | `[]` |

Notes on sizing and behaviour:

- Retention keeps 7 daily, 4 weekly and 6 monthly artifacts **per user** by
  default, and each is a gzipped dump of that user's whole dataset -- so size
  against the number of users, not the number of files.
- A backup that could not include every attachment is kept apart, as
  `monize-backup-partial-<date>`, so it can never take a complete artifact's
  retention slot. Those are bounded by the same daily count, counted separately,
  so a deployment whose attachment storage is failing can hold up to 7 more
  artifacts per user than the figures above until it is fixed.
- Each user's backups go in a server-computed subdirectory named by their user
  id. One user's retention can only ever reach their own artifacts.
- Backup destinations are confined to `BACKUP_ALLOWED_ROOTS` (defaulting to
  `BACKUP_CONTAINER_DIR`). If you mount a second volume through `extraVolumes`
  and want users to be able to select it, add it to that variable as well.
- The claims carry `helm.sh/resource-policy: keep`, so `helm uninstall` does not
  delete a user's only off-database backups or their attachment bytes.
- `fsGroup` is set from `securityContext.runAsGroup` when either store is
  enabled: a freshly provisioned volume is root-owned on most CSI drivers, and
  without it the first write fails with EACCES.
- `/tmp` always gets an `emptyDir`. Node and the `.mny` import both need
  somewhere to spill, and nothing there needs to survive a restart.

### Frontend

| Parameter | Description | Default |
|-----------|-------------|---------|
| `frontend.image.registry` | Image registry | `ghcr.io` |
| `frontend.image.repository` | Image repository | `kenlasko/monize/frontend` |
| `frontend.image.tag` | Image tag | `latest` |
| `frontend.image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `frontend.replicas` | Number of replicas | `1` |
| `frontend.service.port` | Service port | `3000` |
| `frontend.service.type` | Service type | `ClusterIP` |
| `frontend.resources` | CPU/memory requests and limits | See values.yaml |
| `frontend.securityContext` | Container security context | Restricted (non-root, read-only fs) |
| `frontend.livenessProbe` | Liveness probe config | `/api/v1/health/live` |
| `frontend.readinessProbe` | Readiness probe config | `/api/v1/health/ready` |
| `frontend.env.*` | Frontend environment variables | See values.yaml |

### Row-Level Security (RLS)

RLS is an optional defense-in-depth layer that enforces per-user data isolation
in the database itself. It is **off by default**; the standard single-role setup
needs no changes here. See `docs/future-plans/row-level-security.md` (design) and
the runbook for the phased rollout.

| Parameter | Description | Default |
|-----------|-------------|---------|
| `backend.rls.RLS_MODE` | `off` \| `shadow` \| `enforce` (rendered into the backend ConfigMap) | `off` |
| `backend.rls.DATABASE_APP_USER` | Name of the unprivileged runtime role (rendered into the ConfigMap) | `monize_app` |

`RLS_MODE` and `DATABASE_APP_USER` are non-secret and go in the
`env-vars-backend` ConfigMap. The role's password, `DATABASE_APP_PASSWORD`, is a
**secret**: supply it the same way as `DATABASE_PASSWORD`, via `backend.extraEnvFrom`
(a `secretRef`) or `backend.extraEnv` (a `valueFrom.secretKeyRef`). Never put it
in `values.yaml`.

**CNPG `DatabaseRole` requirement.** On the CloudNativePG deployment the
database owner (`DATABASE_USER`) is not a superuser and has **no `CREATEROLE`**,
so the application cannot create the `monize_app` role at startup. Provision it
declaratively with the `DatabaseRole` CRD (CloudNativePG **1.30+**), which gives
the role its own object and reconciliation loop rather than nesting it in the
`Cluster` spec's older `managed.roles` stanza:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: DatabaseRole
metadata:
  name: monize-app
  namespace: monize
spec:
  cluster:
    name: home            # your CNPG Cluster name (matches DATABASE_HOST)
  name: monize_app        # must equal backend.rls.DATABASE_APP_USER
  ensure: present
  login: true
  # Leave superuser/bypassrls at their defaults (false): the runtime role must
  # NOT bypass RLS -- that is the whole point of the unprivileged role.
  passwordSecret:
    name: monize-app-role # a kubernetes.io/basic-auth Secret (username+password)
```

The referenced Secret (`kubernetes.io/basic-auth`, keys `username` +
`password`) also feeds `DATABASE_APP_PASSWORD` into the backend -- point
`backend.extraEnv` at its `password` key:

```yaml
backend:
  extraEnv:
    - name: DATABASE_APP_PASSWORD
      valueFrom:
        secretKeyRef:
          name: monize-app-role
          key: password
```

With the role provisioned this way, backend startup skips role creation and only
applies the role's DML grants (idempotently, on every boot).

> On CloudNativePG **older than 1.30** (no `DatabaseRole` CRD), fall back to the
> `Cluster` spec's `spec.managed.roles` stanza with the same
> `name`/`login`/`passwordSecret` fields.

## Security

All containers enforce the `restricted` Pod Security Standard:
- Run as non-root user (UID 1000)
- Read-only root filesystem
- All Linux capabilities dropped
- RuntimeDefault seccomp profile
- No privilege escalation

## Testing

```bash
# Lint the chart
helm lint ./helm

# Render templates without deploying
helm template monize ./helm -n monize

# Dry-run install
helm install monize ./helm -n monize --dry-run

# Test with Ingress instead of HTTPRoute
helm template monize ./helm -n monize \
  --set httpRoute.enabled=false \
  --set ingress.enabled=true \
  --set ingress.className=nginx
```
