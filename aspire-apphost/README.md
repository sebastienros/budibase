# Budibase with Aspire

Run Budibase **from this checkout**, with Aspire managing its infrastructure,
connections, startup order, health checks, and dashboard. The same TypeScript
AppHost also builds the repository's Dockerfiles and deploys to Docker Compose.

This is a development and local deployment workflow, not a production-hardened
hosting configuration. The [validation and feedback log](STATUS.md) records what
was exercised, problems encountered, and remaining limitations.

## Why use this?

- One resource graph replaces separately starting databases, caches, Node
  processes, and the proxy. The dashboard brings their status and console logs
  together.
- Server and worker use their existing nodemon workflows; client and
  string-template builds watch local source, and the builder uses Vite/HMR.
- Aspire allocates internal ports and resolves connection expressions differently
  for host processes and containers. There are no hand-resolved `localhost`
  connection strings or `host.docker.internal` routing assumptions.
- Secret parameters are generated instead of checked in. Named Docker volumes
  retain data across AppHost restarts.
- Deployment reuses the source-built server, worker, and production proxy
  Dockerfiles rather than replacing Budibase with unrelated prebuilt app images.

No Budibase service code, root workspace dependencies, or existing Compose files
need to change.

## Prerequisites and public CLI installation

Use **Node.js 22.x** (at least 22.13), Corepack, Yarn Classic **1.22.22**, and a
running Docker daemon with Docker Compose v2. Docker 28.0.4 / Compose 2.34.0 were
used for validation. Budibase requires Node 22 even if the Aspire CLI supports
newer Node versions.

Install the public **Aspire CLI 13.5.3**, the latest public 13.5 patch used here:

```sh
curl -fsSL https://aspire.dev/install.sh | bash -s -- --version 13.5.3
export PATH="$HOME/.aspire/bin:$PATH"
aspire --version
```

For an existing standalone CLI installation, this was also exercised:

```sh
aspire update --self --channel stable --yes --non-interactive
```

The update command follows the latest stable release, so use the version-pinned
installer when reproducing this configuration. The AppHost SDK and its four
hosting packages are pinned to `13.5.3` in `aspire.config.json`. `NuGet.Config`
keeps restores on nuget.org, independent of inherited daily-feed source mappings.
No daily CLI or preview hosting packages are required.

The Compose dashboard is explicitly pinned to the public
`mcr.microsoft.com/dotnet/aspire-dashboard:13.5.2`: a public `13.5.3` dashboard
image was not available during validation. The **CLI and AppHost remain 13.5.3**.

## First run

From the repository root, with Node 22 first on `PATH`:

```sh
node --version
corepack enable
corepack install --global yarn@1.22.22
yarn --version
yarn install --frozen-lockfile
yarn dev:init
yarn build

cd aspire-apphost
npm ci
aspire restore --non-interactive
aspire start --non-interactive
aspire wait proxy-service --timeout 180 --non-interactive
```

`yarn dev:init` only creates/updates the existing development `.env`; the server
refuses to start in development without it. Aspire overrides the infrastructure
addresses and credentials in each process environment. Do **not** run root
`yarn dev` alongside Aspire: it starts a competing Compose stack and frees ports.
If using an existing `.env`, review unrelated settings such as `APP_PORT`,
`CLUSTER_MODE`, or multi-tenancy overrides before starting.

The root uses Yarn Classic, but the AppHost has its own **npm lockfile**. Keep
`package-lock.json`: without this boundary, Aspire detects the root Yarn v1
lockfile and rejects the TypeScript AppHost. Its `.npmrc` and lockfile use the
public npm registry rather than a machine-specific package mirror. Vite's
per-resource dependency installer is disabled because workspace dependencies
were installed once at the root.

Open **http://localhost:10000/builder/**. The dashboard login URL is printed by
`aspire start`. For foreground operation, use `aspire run` instead.

The initial admin email is `local@budibase.com`. Retrieve its generated
**local-development** password privately:

```sh
aspire secret get Parameters:bb-admin-user-password
```

This is not the standard `yarn dev` password. To supply your own initial
credentials, use `aspire secret set Parameters:bb-admin-user-email <email>` and
`aspire secret set Parameters:bb-admin-user-password <password>` **before the
first run**. Changing a bootstrap parameter does not reset an existing Budibase
account. Do not paste credentials or dashboard login tokens into an issue or PR.

## Resource graph and connections

| Resource | Local run | Compose |
|---|---|---|
| `app-service` | Source server via nodemon | `packages/server/Dockerfile` |
| `worker-service` | Source worker via nodemon | `packages/worker/Dockerfile` |
| `builder-dev` | Vite with HMR through Nginx | Built assets inside the server image |
| `client-dev`, `string-templates-dev` | Source build watchers | Prebuilt before publishing |
| `proxy-service` | Nginx with `nginx.dev.conf` | `hosting/proxy/Dockerfile` |
| `couchdb-service` | Budibase CouchDB + SQL query service | Same image |
| `minio-service` | S3-compatible object storage | Same image |
| `redis-service` | Aspire Redis integration | Same Redis resource |
| `litellm-db`, `litellm` | Aspire Postgres server/database | Postgres image with database initialized |
| `litellm-service` | LiteLLM with the repository configuration | Same image and configuration |

Budibase consumes its own environment variable names, not
`ConnectionStrings__...` or `services__...`. Therefore the AppHost uses
`withEnvironment` with structured values rather than injecting unused
`withReference` variables:

| Consumer setting | Source |
|---|---|
| LiteLLM `DATABASE_URL` | `litellmDb.getConnectionProperty("Uri")` |
| `REDIS_URL` | Deferred Redis `Host` + `Port` properties |
| `REDIS_PASSWORD` | Redis `Password` property |
| `COUCH_DB_URL`, `COUCH_DB_SQL_URL` | CouchDB's HTTP and `sqs` endpoints |
| `COUCH_DB_USER`, `COUCH_DB_PASSWORD` | Shared parameter resources |
| `MINIO_URL`, `LITELLM_URL`, `WORKER_URL`, `APPS_URL` | Resource endpoint references |
| Development Nginx upstreams | `endpoint.property(EndpointProperty.HostAndPort)` |

The Postgres `Uri` handles URI encoding and container-local host/port selection.
Redis credentials stay separate because Budibase's Redis parser is not a .NET
connection-string parser. Redis explicitly disables Aspire's HTTPS certificate
provisioning to match Budibase's plain Redis connection.

In particular, backend-core reads **`COUCH_DB_USER`**, even though its internal
property is named `COUCH_DB_USERNAME`. Explicitly supplying `COUCH_DB_SQL_URL`
also avoids Budibase falling back to the fixed development SQL port.

Only the public proxy port is fixed at `10000`, matching the repository workflow.
Vite's HMR client and the worker's cluster port use that same value. Internal
development ports are Aspire-managed. The dashboard profile retains ports
`15100`, `19100`, and `20100` from the original AppHost. HTTP is intentional for
this local Nginx/Node stack; add a proper TLS boundary before remote hosting.

## Health, logs, and stopping

```sh
# Run from aspire-apphost.
aspire describe --include-hidden --format Json --non-interactive
aspire logs worker-service --tail 80 --non-interactive
aspire logs app-service --tail 80 --non-interactive
aspire resource app-service restart --non-interactive
aspire stop --non-interactive
```

| Resource | Local health check |
|---|---|
| Postgres server/database, Redis | Integration-provided connection checks |
| CouchDB | `GET /_up` |
| MinIO | `GET /minio/health/live` |
| LiteLLM | `GET /health/liveliness` |
| Worker, app | `GET /health` |
| Vite | `GET /builder/` |
| Development proxy | `GET /health`, forwarded to the app |

`builder-dev-installer` remaining `NotStarted` is intentional. The client and
string-template watchers have process status, not application health probes;
the initial `yarn build` is still required. Routify routes are generated by that
build; run the builder's existing build again after changing route files.

If a service is `Running` but `Unhealthy`, inspect its logs before weakening the
check: nodemon remains running when its Node child crashes. An app waiting for
the worker, and a proxy waiting for the app, are expected dependency behavior.

## Docker Compose deployment

Build the repository first as above. Stop the local AppHost to free port 10000:

```sh
cd aspire-apphost
aspire stop --non-interactive
aspire publish --list-steps --non-interactive
aspire publish --non-interactive
aspire deploy --list-steps --non-interactive
aspire deploy --environment Validation --non-interactive
```

For image builds and environment preparation without starting containers:

```sh
aspire do prepare-compose --environment Validation --non-interactive
```

Aspire writes `aspire-output/docker-compose.yaml`. Publish creates `.env`
placeholders; prepare/deploy writes resolved `.env.Validation`, including secrets
and local image tags. Deployment parameters are persisted separately from
development user secrets: get the **deployment** admin password from
`BB_ADMIN_USER_PASSWORD` in `.env.Validation`, not `aspire secret get`.
Keep the deployment state and credentials when reusing its data volumes.

The app and worker images consume this checkout's `dist`, builder, client, and
lockfile outputs using the repository Dockerfiles. No registry is configured:
pipeline steps named `push-*` only tag local images; they do not upload images.

Builds explicitly target Linux ARM64 on an ARM64 AppHost and Linux AMD64 otherwise.
This avoids running Budibase's native Node modules under x64 emulation on Apple
Silicon. For a remote Docker daemon with a different architecture, change
`containerPlatform` to the target architecture rather than relying on the
AppHost host's architecture.

`POSTGRES_DB=litellm` initializes the database on a fresh Compose volume;
`addDatabase`'s local initialization alone is not sufficient in the generated
Compose model. LiteLLM's config is a read-only bind mount:
`LITELLM_SERVICE_BINDMOUNT_0` in the environment file must point to
`hosting/litellm_config.yaml` on the Docker host. The generated directory is not
a self-contained remote deployment bundle.

**Do not treat `aspire deploy` success or the production proxy's `/health` as an
end-to-end readiness check.** In 13.5.3 the generated Compose file did not include
the AppHost's health checks, and dependencies used `service_started`. Production
Nginx returns its own static health response. Inspect real backends and use the UI:

```sh
docker compose ls
# Use the project name shown above, not a new Compose project.
docker compose -p <project-name> --env-file aspire-output/.env.Validation \
  -f aspire-output/docker-compose.yaml ps --all
docker compose -p <project-name> --env-file aspire-output/.env.Validation \
  -f aspire-output/docker-compose.yaml exec -T app-service \
  curl -fsS http://localhost:4001/health
docker compose -p <project-name> --env-file aspire-output/.env.Validation \
  -f aspire-output/docker-compose.yaml exec -T worker-service \
  curl -fsS http://localhost:4002/health
```

Open http://localhost:10000/builder/, sign in, and exercise the application.
The dashboard gets a dynamically published port printed by deployment.

To stop this deployment without deleting data:

```sh
docker compose -p <project-name> --env-file aspire-output/.env.Validation \
  -f aspire-output/docker-compose.yaml stop
```

`aspire stop` stops local development, not a Compose deployment. Use
`aspire destroy --environment Validation` only when you intend to tear down the
deployment, after backing up any data you need.

## Data and scope

Development and Compose use separate named volumes. They are not migrations of
the original preview AppHost's `data/` bind mounts; existing `data/` is left
untouched. Back up and migrate old data deliberately rather than deleting it to
resolve a credential mismatch.

Generated `.aspire/` modules, local `.env*`, `aspire-output/`, and data are ignored.
Edit `apphost.mts`, never generated SDK modules or generated Compose YAML.

Console logs are available in the local dashboard, but this does not add a
Budibase OpenTelemetry bootstrap. Distributed traces, cloud deployment,
external AI models, and production security/backup/restart policies are outside
the validated scope. See [STATUS.md](STATUS.md) for concrete feedback candidates.
