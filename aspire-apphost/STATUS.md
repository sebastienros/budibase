# Aspire validation and feedback

Validated on **2026-09-08**, in the existing fork PR
[sebastienros/budibase#1](https://github.com/sebastienros/budibase/pull/1).
No upstream PR or issue was created. These notes distinguish confirmed behavior
from hypotheses and configuration mistakes.

## Environment

| Component | Version |
|---|---|
| Aspire CLI, SDK, JavaScript/PostgreSQL/Redis/Docker integrations | Public 13.5.3 |
| CLI commit | `b5f143315ffb6968ea939a9978797a5b20e4c688` |
| Host | macOS ARM64; Docker Linux ARM64 |
| Node / Yarn | 22.23.2 / 1.22.22 |
| Docker / Compose | 28.0.4 / 2.34.0 |
| Compose dashboard | Public 13.5.2 image |
| Browser | Firefox via Playwright |

## Confirmed outcomes

| Surface | Result |
|---|---|
| Repository preparation | Frozen Yarn Classic install, `yarn dev:init`, and existing `yarn build` completed |
| AppHost | Generated SDK restored; existing TypeScript build command passed; public CLI started `apphost.mts` |
| Local readiness | App, worker, proxy, Vite, CouchDB, MinIO, Redis, Postgres server/database, and LiteLLM healthy |
| Local watch resources | Client and string-template watchers running; Vite installer intentionally disabled |
| Local browser | Generated admin login; default workspace created; `AspireValidation` table and text field created; saved row remained after reload and a full AppHost stop/start with login retained |
| Vite routing | Browser reported Vite connected through Nginx on port 10000 |
| Compose publication | All seven publish steps passed; deployment topology contained no source watchers |
| Compose image build | Repository server, worker, and proxy Dockerfiles built successfully |
| Compose deployment | All 33 deployment steps completed after correcting dashboard image and build architecture |
| Actual deployed health | All nine containers running; app and worker `/health` returned 200; Redis PING, Postgres database connection, CouchDB, MinIO, and LiteLLM probes passed |
| Deployed browser | Deployment-specific admin login; created `AspireComposeValidation`; added visible text; published workspace successfully |
| Live app | `/app/default%20workspace/aspirecomposevalidation` rendered `Aspire 13.5 Compose works`, including after reload |

The app was source-built, not a prebuilt Budibase application image. Publication
exercised the app-asset path; a dedicated attachment upload/download test was not
performed. No external AI provider or paid model was invoked.

Validation processes were stopped afterward. Named data volumes and ignored
deployment output were retained, not deleted.

## Aspire feedback candidates

### Stable update from a daily TypeScript AppHost

Command:

```sh
aspire update --apphost aspire-apphost/apphost.ts \
  --channel stable --yes --migrate --non-interactive
```

The CLI proposed upgrading the SDK and JavaScript integration to 13.5.3, but
regeneration still reported `channel: daily`. Restore selected the daily
`dotnet9` feed for Aspire packages and did not consider nuget.org:
`Unable to find a stable package Aspire.Hosting with version (>= 13.5.3)`.
The command still migrated `apphost.ts` to `apphost.mts` and exited 0; the
configuration retained the preview SDK/package versions.

**Resolution:** Explicit stable pins and a local `NuGet.Config` clearing inherited
sources/mappings. The exact contribution of inherited machine mappings versus
update ordering needs an isolated upstream reproduction. Feedback: update should
use the selected channel during regeneration and make partial failure visible to
automation.

### TypeScript AppHost inside a Yarn Classic monorepo

`aspire restore` initially failed:

```text
Yarn Classic is not supported for TypeScript AppHosts.
Upgrade the Yarn lockfile ... to Yarn 4 or later, or use npm, pnpm, or Bun.
```

The AppHost is outside Budibase's `packages/*` workspace, but the CLI discovered
the root `yarn.lock`. Creating the AppHost's own npm `package-lock.json` made
restore succeed without changing Budibase's package manager. Documenting this
escape hatch would help migrations of established monorepos.

### Documentation and generated TypeScript signatures differ

The 13.5.3 API documentation displayed positional optional arguments for
`addPostgres(name, userName?, password?, port?)`, but the generated SDK accepts
`addPostgres(name, { userName, password, port })`. The documented
`ContainerTargetPlatform` enum was numeric while generated enum values were
strings. Use imports and actual generated declarations, not copied numeric
values or guessed overloads. No generated modules were edited.

Also, `aspire add postgres --version 13.5.3 --non-interactive` rejected the
friendly name; `aspire add Aspire.Hosting.PostgreSQL --version 13.5.3
--non-interactive` succeeded.

### Compose dashboard image selection

The default 13.5.3 Compose output selected:

```text
mcr.microsoft.com/dotnet/nightly/aspire-dashboard:13.5
```

An explicit public `dotnet/aspire-dashboard:13.5.3` failed to pull (`not found`).
The public registry listed `13.5` and `13.5.2`, but not `13.5.3`.
The AppHost now uses public `13.5.2`. Feedback: clarify stable CLI/dashboard image
version alignment and avoid an unexpected nightly repository in stable output.
The deployment error also advised ensuring Docker was installed despite the real
cause being an unavailable image tag.

### Compose defaults to AMD64 on an ARM64 Docker host

Initial Aspire image builds were `linux/amd64` although Docker reported
`aarch64`. The app exited with `SIGILL` shortly after initializing its query
worker farm. The worker and infrastructure remained up.

**Resolution:** Set `ContainerBuildOptionsCallbackContext.targetPlatform` to the
local architecture. Rebuilding the same source as `linux/arm64` started normally
and passed the live-app exercise. Native module execution under emulation is the
likely cause; the precise faulting instruction/module was not profiled.

Feedback: a local Compose deployment could default to Docker's architecture, or
warn prominently about emulation.

### Deployment success does not imply healthy application

After the AMD64 attempt, `aspire deploy` printed **33/33 steps succeeded** and
"Successfully deployed app-service". Immediately afterward:

- `app-service` had exited with code 1.
- `/builder/` returned 502.
- The production Nginx `/health` returned 200, because it is a static proxy check.

The generated Compose YAML contained no health checks corresponding to
`withHttpHealthCheck`, and `waitFor` dependencies became `service_started`.
`docker inspect` confirmed `Config.Healthcheck=null` for the app.
This is a confirmed readiness gap, not a claim that every AppHost health check
can be automatically translated into a container command. The generated
TypeScript Compose service surface also did not expose a healthcheck property.

Feedback: preserve supported readiness semantics, expose Compose healthcheck
customization, or explicitly distinguish "containers started" from "app ready".
The README requires backend and browser checks instead of relying on the
pipeline/proxy result.

### Database initialization and deployment portability

`addDatabase("litellm")` created the database in local run mode. Initial Compose
output only configured Postgres's user/password, without `POSTGRES_DB` or an
initialization service for the named database. The AppHost now sets
`POSTGRES_DB=litellm` so a new Compose volume initializes the database referenced
by LiteLLM's `Uri`. Missing-database failure was prevented by artifact inspection,
not observed as a deployed crash.

The LiteLLM bind mount was correctly converted to
`${LITELLM_SERVICE_BINDMOUNT_0}`, with a portability warning. It remains a
host-specific input, not a bundled configuration artifact.

### Development and deployment credentials are separate

The persisted development admin password did not match
`BB_ADMIN_USER_PASSWORD` in `.env.Validation`. The first Compose browser login
with the development credential failed; the deployment credential succeeded.
This is documented behavior to make clearer, not evidence that secret generation
is broken. The generated secret files and deployment state were not committed.

## Budibase/configuration roadblocks resolved

| Problem | Diagnosis and resolution |
|---|---|
| Node/Yarn mismatch | Machine defaults were Node 24 / Yarn 4. Selected Node 22 and Yarn 1.22.22; no workspace migration |
| Docker unavailable | Started Docker Desktop; no existing running containers were replaced |
| Worker `Running` but unhealthy | nodemon's child crashed with `CouchDB username not set`. Corrected AppHost injection to `COUCH_DB_USER`, which backend-core actually reads |
| App failed before listening | Fresh checkout lacked `.env`; existing `yarn dev:init` resolved `Must run via yarn once to generate environment` |
| Apparent stuck dependency chain | App correctly waited for healthy worker; proxy correctly waited for healthy app. Did not remove or weaken checks |
| Initial app HTTP 503 | Backend was still initializing; subsequently returned 200 without changing probe path/status |
| Native module setup | Frozen install and normal build worked under Node 22; manual native rebuilds were not needed in this run |
| Machine-specific npm mirror | Initial npm lockfile used the host's configured mirror. Regenerated AppHost dependencies against public npm and scoped `.npmrc` to this folder |

## Scope and uncertainties

Only this fork's existing branch/PR is updated. No Aspire feedback issues were
filed; the items above are candidates for a separately reviewed report.

Not established: production hardening, failover/restart policies, TLS termination,
remote/mismatched-architecture Docker hosts, x64-native validation, Windows/Linux
source development, external AI calls, large uploads, or a full Budibase test
suite. Browser builds emitted existing Svelte/Vite warnings; these did not block
the exercised flows and their upstream origin was not investigated.

The dashboard collects resource status and console logs. This work did not add
an OpenTelemetry bootstrap to Budibase, so distributed tracing is not claimed.

The original preview AppHost's missing TypeScript `HostAndPort` limitation is
**resolved**: public 13.5.3 exposes `EndpointProperty.HostAndPort`, and native
Postgres connection properties remove the old literal `litellm-db:5432` workaround.
