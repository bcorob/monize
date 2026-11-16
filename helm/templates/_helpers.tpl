{{/*
Expand the name of the chart.
*/}}
{{- define "monize.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "monize.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Chart label values.
*/}}
{{- define "monize.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Resolve the application hostname.
Defaults to monize.<global.domain>
*/}}
{{- define "monize.hostname" -}}
{{- if .Values.global.hostname }}
{{- .Values.global.hostname }}
{{- else }}
{{- printf "monize.%s" .Values.global.domain }}
{{- end }}
{{- end }}

{{/*
Resolve the public app URL.
Defaults to https://<hostname>
*/}}
{{- define "monize.publicAppUrl" -}}
{{- printf "https://%s" (include "monize.hostname" .) }}
{{- end }}

{{/*
Resolve the OIDC issuer URL.
Defaults to https://auth.<global.domain>
*/}}
{{- define "monize.oidcIssuerUrl" -}}
{{- if .Values.backend.oidc.OIDC_ISSUER_URL }}
{{- .Values.backend.oidc.OIDC_ISSUER_URL }}
{{- else }}
{{- printf "https://auth.%s" .Values.global.domain }}
{{- end }}
{{- end }}

{{/*
Resolve the OIDC callback URL.
Defaults to https://<hostname>/api/v1/auth/oidc/callback
*/}}
{{- define "monize.oidcCallbackUrl" -}}
{{- if .Values.backend.oidc.OIDC_CALLBACK_URL }}
{{- .Values.backend.oidc.OIDC_CALLBACK_URL }}
{{- else }}
{{- printf "https://%s/api/v1/auth/oidc/callback" (include "monize.hostname" .) }}
{{- end }}
{{- end }}

{{/*
Resolve the internal API URL for the frontend.
Defaults to http://monize-backend-service:<backend.service.port>
*/}}
{{- define "monize.internalApiUrl" -}}
{{- if .Values.frontend.app.INTERNAL_API_URL }}
{{- .Values.frontend.app.INTERNAL_API_URL }}
{{- else }}
{{- printf "http://monize-backend-service:%v" (.Values.backend.service.port | int) }}
{{- end }}
{{- end }}

{{/*
Common labels for backend resources.
*/}}
{{- define "monize.backend.labels" -}}
app: monize-backend
app.kubernetes.io/name: monize-backend
app.kubernetes.io/version: {{ .Values.backend.image.tag | quote }}
app.kubernetes.io/component: backend
app.kubernetes.io/part-of: monize
helm.sh/chart: {{ include "monize.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels for backend.
*/}}
{{- define "monize.backend.selectorLabels" -}}
app: monize-backend
{{- end }}

{{/*
Common labels for frontend resources.
*/}}
{{- define "monize.frontend.labels" -}}
app: monize-frontend
app.kubernetes.io/name: monize-frontend
app.kubernetes.io/version: {{ .Values.frontend.image.tag | quote }}
app.kubernetes.io/component: frontend
app.kubernetes.io/part-of: monize
helm.sh/chart: {{ include "monize.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels for frontend.
*/}}
{{- define "monize.frontend.selectorLabels" -}}
app: monize-frontend
{{- end }}

{{/*
The configured attachment storage provider, read out of backend.extraEnv so
NOTES.txt can warn when "local" has no volume behind it. Defaults to "database",
matching the backend's own default.
*/}}
{{- define "monize.attachmentProvider" -}}
{{- $provider := "database" -}}
{{- range .Values.backend.extraEnv -}}
{{- if eq .name "ATTACHMENT_STORAGE_PROVIDER" -}}
{{- $provider = .value | default "database" -}}
{{- end -}}
{{- end -}}
{{- $provider | lower -}}
{{- end -}}

{{/*
The configured backup storage target, read out of backend.extraEnv the same way
the attachment provider is, so NOTES.txt and the shared-volume warnings can tell
a local store (which needs a volume every replica mounts) from an s3 one (which
every replica reaches by construction). Defaults to "local", matching the
backend's own default in every cluster mode.
*/}}
{{- define "monize.backupStore" -}}
{{- $store := "local" -}}
{{- range .Values.backend.extraEnv -}}
{{- if eq .name "BACKUP_STORAGE_PROVIDER" -}}
{{- $store = .value | default "local" -}}
{{- end -}}
{{- end -}}
{{- $store | lower -}}
{{- end -}}

{{/*
Whether a value means "true", tested exactly rather than for truthiness.

A plain `if` on cluster.backupSharedVolume is true for the *string* "false",
which is what `--set cluster.backupSharedVolume=false` produces under some
wrappers and what a values file writes when the key is quoted. The one place
that matters most is an assertion the backend cannot verify: emitting
BACKUP_SHARED_VOLUME=true because the operator wrote "false" would turn a boot
refusal into two replicas quietly writing backups to two different disks.

Called through `include` and compared to the string "true" by every caller.
*/}}
{{- define "monize.isTrue" -}}
{{- if kindIs "bool" . -}}
{{- if . }}true{{ end -}}
{{- else -}}
{{- if eq (lower (toString (default "" .))) "true" }}true{{ end -}}
{{- end -}}
{{- end -}}

{{/*
Whether CLUSTER_MODE is multi.
*/}}
{{- define "monize.clusterMulti" -}}
{{- if eq (lower (toString (.Values.cluster.mode | default "single"))) "multi" }}true{{ end -}}
{{- end -}}

{{/*
A topologySpreadConstraint whose labelSelector matches no pod is not a weaker
constraint -- it is no constraint at all, satisfied by any placement, including
every replica on one node. The chart's own example used
`app.kubernetes.io/name: monize` while the pod template carries
`app.kubernetes.io/name: monize-backend`, which renders, installs and schedules
cleanly while doing nothing.

So every matchLabels key/value here must be one the pod template actually
carries. matchExpressions are passed through unchecked: their semantics are
richer than a subset test, and an operator writing one is past the mistake this
guards.

Usage: include "monize.assertSpreadSelectors" (dict "constraints" ... "podLabels" ... "path" "backend")
*/}}
{{- define "monize.assertSpreadSelectors" -}}
{{- $podLabels := .podLabels -}}
{{- $path := .path -}}
{{- range $i, $constraint := .constraints -}}
{{- $selector := $constraint.labelSelector | default dict -}}
{{- $matchLabels := $selector.matchLabels | default dict -}}
{{- if and (not $matchLabels) (not $selector.matchExpressions) -}}
{{- fail (printf "%s.topologySpreadConstraints[%d] has no labelSelector: a constraint that selects no pods is satisfied by every placement, including all replicas on one node. Select the pods this workload creates, e.g. matchLabels: {app: %s}." $path $i (index $podLabels "app")) -}}
{{- end -}}
{{- range $key, $value := $matchLabels -}}
{{- $actual := index $podLabels $key -}}
{{- if ne (toString $value) (toString ($actual | default "")) -}}
{{- fail (printf "%s.topologySpreadConstraints[%d] selects %s=%s, but this workload's pods are labelled %s=%s. A selector that matches no pod imposes no spread at all; the replicas may all land on one node with the constraint reported as satisfied." $path $i $key (toString $value) $key (toString ($actual | default "<absent>"))) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
CLUSTER_MODE=single means the backend keeps rate-limit counters, single-use
claims and the relay's wake-ups inside one process. A second replica does not
share them: every @Throttle cap is enforced once per pod, and an SSE stream on
one pod never hears the answer produced on the other. Nothing inside a replica
can detect the second one, so this is the only place it can be refused -- and
it is refused here rather than warned about, because the failure mode is a rate
limit that is silently twice what it says.

Only the backend is checked. The frontend is stateless per request and scales
freely at either mode.
*/}}
{{- define "monize.assertClusterMode" -}}
{{- if not (include "monize.clusterMulti" .) -}}
{{- $autoscaling := .Values.backend.autoscaling | default dict -}}
{{- if gt (int .Values.backend.replicas) 1 -}}
{{- fail (printf "backend.replicas is %d with cluster.mode=single. A second backend replica does not share rate-limit counters, single-use claims or relay wake-ups with the first, so limits are enforced per pod and AI answers are lost when the two halves of a conversation land differently. Set cluster.mode=multi (and read its notes on DATABASE_HOST and shared storage), or keep one replica." (int .Values.backend.replicas)) -}}
{{- end -}}
{{- if (include "monize.isTrue" $autoscaling.enabled) -}}
{{- if gt (int ($autoscaling.maxReplicas | default 1)) 1 -}}
{{- fail (printf "backend.autoscaling.maxReplicas is %d with cluster.mode=single. The autoscaler would scale past one backend replica under load -- exactly when a doubled rate limit matters most -- and nothing inside a pod can detect the second one. Set cluster.mode=multi, or cap maxReplicas at 1." (int ($autoscaling.maxReplicas | default 1))) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
