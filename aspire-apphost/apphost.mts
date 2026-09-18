import {
  createBuilder,
  ContainerTargetPlatform,
  EndpointProperty,
  refExpr,
} from "./.aspire/modules/aspire.mjs"

const builder = await createBuilder()
const isPublish = await builder.executionContext().isPublishMode()
const publicPort = 10000
const containerPlatform =
  process.arch === "arm64"
    ? ContainerTargetPlatform.LinuxArm64
    : ContainerTargetPlatform.LinuxAmd64

await builder
  .addDockerComposeEnvironment("compose")
  .configureDashboard(async dashboard => {
    await dashboard
      .withImage("dotnet/aspire-dashboard")
      .withImageRegistry("mcr.microsoft.com")
      .withImageTag("13.5.2")
  })

const generatedSecret = {
  minLength: 32,
  lower: true,
  upper: true,
  numeric: true,
  special: false,
}
const secret = (name: string) =>
  builder.addParameterWithGeneratedValue(name, generatedSecret, {
    secret: true,
    persist: true,
  })

const apiEncryptionKey = await secret("api-encryption-key")
const encryptionKey = await secret("encryption-key")
const jwtSecret = await secret("jwt-secret")
const internalApiKey = await secret("internal-api-key")
const minioAccessKey = await secret("minio-access-key")
const minioSecretKey = await secret("minio-secret-key")
const couchDbUser = await builder.addParameter("couch-db-user", {
  value: "budibase",
})
const couchDbPassword = await secret("couch-db-password")
const litellmMasterKey = await secret("litellm-master-key")
const litellmSaltKey = await secret("litellm-salt-key")
const adminEmail = await builder.addParameter("bb-admin-user-email", {
  value: "local@budibase.com",
})
const adminPassword = await secret("bb-admin-user-password")

const postgres = await builder
  .addPostgres("litellm-db")
  .withImageTag("16")
  // AddDatabase initializes run mode; the official image initializes Compose.
  .withEnvironment("POSTGRES_DB", "litellm")
  .withDataVolume()
const litellmDb = await postgres.addDatabase("litellm")

const litellm = await builder
  .addContainer("litellm-service", "ghcr.io/berriai/litellm")
  .withImageTag("main-v1.81.14-stable")
  .withBindMount("../hosting/litellm_config.yaml", "/app/config.yaml", {
    isReadOnly: true,
  })
  .withEnvironment("STORE_MODEL_IN_DB", "True")
  .withEnvironment("LITELLM_REASONING_AUTO_SUMMARY", "true")
  .withEnvironment("LITELLM_MASTER_KEY", litellmMasterKey)
  .withEnvironment("LITELLM_SALT_KEY", litellmSaltKey)
  .withEnvironment("DATABASE_URL", await litellmDb.getConnectionProperty("Uri"))
  .withArgs(["--config", "/app/config.yaml"])
  .withHttpEndpoint({ targetPort: 4000 })
  .withHttpHealthCheck({ path: "/health/liveliness" })
  .waitFor(litellmDb)

const minio = await builder
  .addContainer("minio-service", "minio/minio")
  .withImageTag("RELEASE.2025-09-07T16-13-09Z")
  .withEnvironment("MINIO_ROOT_USER", minioAccessKey)
  .withEnvironment("MINIO_ROOT_PASSWORD", minioSecretKey)
  .withEnvironment("MINIO_BROWSER", "off")
  .withArgs(["server", "/data", "--console-address", ":9001"])
  .withVolume("/data", { name: "budibase-aspire-minio" })
  .withHttpEndpoint({ targetPort: 9000 })
  .withHttpHealthCheck({ path: "/minio/health/live" })

const couchDb = await builder
  .addContainer("couchdb-service", "budibase/database")
  .withImageTag("2.1.0")
  .withEnvironment("COUCHDB_USER", couchDbUser)
  .withEnvironment("COUCHDB_PASSWORD", couchDbPassword)
  .withEnvironment("TARGETBUILD", "docker-compose")
  .withEnvironment("DATA_DIR", "/data")
  .withVolume("/data", { name: "budibase-aspire-couchdb" })
  .withHttpEndpoint({ targetPort: 5984 })
  .withHttpEndpoint({ targetPort: 4984, name: "sqs" })
  .withHttpHealthCheck({ path: "/_up" })

const redis = await builder
  .addRedis("redis-service")
  .withImageTag("7.4")
  .withDataVolume()
  .withoutHttpsCertificate()

// Budibase reads host:port and password separately
const redisAddress = refExpr`${await redis.getConnectionProperty("Host")}:${await redis.getConnectionProperty("Port")}`

const worker = await builder
  .addExecutable("worker-service", "corepack", "../packages/worker", [
    "yarn@1.22.22",
    "dev",
  ])
  .withHttpEndpoint({
    env: "WORKER_PORT",
    targetPort: isPublish ? 4002 : undefined,
  })
  .withHttpHealthCheck({ path: "/health" })
  .publishAsDockerFile(async container => {
    await container
      .withDockerfile("..", { dockerfilePath: "packages/worker/Dockerfile" })
      .withBuildArg("BUDIBASE_VERSION", "0.0.0+aspire")
  })

const app = await builder
  .addExecutable("app-service", "corepack", "../packages/server", [
    "yarn@1.22.22",
    "exec",
    "nodemon",
  ])
  .withHttpEndpoint({
    env: "APPS_PORT",
    targetPort: isPublish ? 4001 : undefined,
  })
  .withHttpHealthCheck({ path: "/health" })
  .withEnvironment("WORKER_URL", worker.getEndpoint("http"))
  .withEnvironment("BUDIBASE_ENVIRONMENT", "PRODUCTION")
  .withEnvironment("BB_ADMIN_USER_EMAIL", adminEmail)
  .withEnvironment("BB_ADMIN_USER_PASSWORD", adminPassword)
  .waitFor(worker)
  .publishAsDockerFile(async container => {
    await container
      .withDockerfile("..", { dockerfilePath: "packages/server/Dockerfile" })
      .withBuildArg("BUDIBASE_VERSION", "0.0.0+aspire")
  })

for (const service of [worker, app]) {
  await service
    .withEnvironment("SELF_HOSTED", "1")
    .withEnvironment(
      "PORT",
      service.getEndpoint("http").property(EndpointProperty.TargetPort)
    )
    .withEnvironment("JWT_SECRET", jwtSecret)
    .withEnvironment("ENCRYPTION_KEY", encryptionKey)
    .withEnvironment("API_ENCRYPTION_KEY", apiEncryptionKey)
    .withEnvironment("INTERNAL_API_KEY", internalApiKey)
    .withEnvironment("MINIO_ACCESS_KEY", minioAccessKey)
    .withEnvironment("MINIO_SECRET_KEY", minioSecretKey)
    .withEnvironment("MINIO_URL", minio.getEndpoint("http"))
    .withEnvironment("REDIS_URL", redisAddress)
    .withEnvironment(
      "REDIS_PASSWORD",
      await redis.getConnectionProperty("Password")
    )
    .withEnvironment("COUCH_DB_URL", couchDb.getEndpoint("http"))
    .withEnvironment("COUCH_DB_USER", couchDbUser)
    .withEnvironment("COUCH_DB_PASSWORD", couchDbPassword)
    .withEnvironment("COUCH_DB_SQL_URL", couchDb.getEndpoint("sqs"))
    .withEnvironment("LITELLM_URL", litellm.getEndpoint("http"))
    .withEnvironment("LITELLM_MASTER_KEY", litellmMasterKey)
    .withEnvironment("DISABLE_ACCOUNT_PORTAL", "1")
    .withEnvironment("ENABLE_ANALYTICS", "false")
    .withEnvironment("POSTHOG_TOKEN", "")
    .waitFor(redis)
    .waitFor(minio)
    .waitFor(couchDb)
    .waitFor(litellm)
}

const proxy = await builder
  .addContainer("proxy-service", "nginx")
  .withImageTag("1.28")
  .withHttpEndpoint({ port: publicPort, targetPort: 10000 })
  .withExternalHttpEndpoints()
  .withHttpHealthCheck({ path: "/health" })
  .waitFor(app)

if (isPublish) {
  await proxy
    .withDockerfile("../hosting/proxy")
    .withEnvironment("APPS_UPSTREAM_URL", app.getEndpoint("http"))
    .withEnvironment("WORKER_UPSTREAM_URL", worker.getEndpoint("http"))
    .withEnvironment("MINIO_UPSTREAM_URL", minio.getEndpoint("http"))
    .withEnvironment("COUCHDB_UPSTREAM_URL", couchDb.getEndpoint("http"))
} else {
  const stringTemplates = await builder.addExecutable(
    "string-templates-dev",
    "corepack",
    "../packages/string-templates",
    ["yarn@1.22.22", "dev"]
  )
  const client = await builder
    .addExecutable("client-dev", "corepack", "../packages/client", [
      "yarn@1.22.22",
      "dev",
    ])
    .waitFor(stringTemplates)
  const builderDev = await builder
    .addViteApp("builder-dev", "../packages/builder", {
      runScriptName: "dev:vite",
    })
    .withYarn({ install: false })
    .withEnvironment("VITE_HMR_CLIENT_PORT", String(publicPort))
    .withHttpHealthCheck({ path: "/builder/" })
    .waitFor(stringTemplates)

  await app.waitFor(client)
  await proxy
    .withEnvironment("NGINX_ENVSUBST_OUTPUT_DIR", "/etc/nginx")
    .withEnvironment(
      "APPS_UPSTREAM",
      app.getEndpoint("http").property(EndpointProperty.HostAndPort)
    )
    .withEnvironment(
      "WORKER_UPSTREAM",
      worker.getEndpoint("http").property(EndpointProperty.HostAndPort)
    )
    .withEnvironment(
      "BUILDER_UPSTREAM",
      builderDev.getEndpoint("http").property(EndpointProperty.HostAndPort)
    )
    .withEnvironment("COUCHDB_UPSTREAM_URL", couchDb.getEndpoint("http"))
    .withEnvironment("MINIO_UPSTREAM_URL", minio.getEndpoint("http"))
    .withBindMount(
      "./nginx.dev.conf",
      "/etc/nginx/templates/nginx.conf.template",
      {
        isReadOnly: true,
      }
    )
    .withBindMount(
      "../hosting/proxy/error.html",
      "/usr/share/nginx/html/error.html",
      {
        isReadOnly: true,
      }
    )
    .waitFor(builderDev)
}

await worker
  .withEnvironment("APPS_URL", app.getEndpoint("http"))
  .withEnvironment("CLUSTER_PORT", String(publicPort))

for (const service of [worker, app, proxy]) {
  await service.withContainerBuildOptions(async options => {
    await options.targetPlatform.set(containerPlatform)
  })
}

await builder.build().run()
