import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const lock = JSON.parse(await readFile(resolve(scriptDirectory, "lock.json"), "utf8"));
const dataDirectory = resolve(process.env.PLANE_CE_DATA_DIR ?? resolve(repoRoot, ".data/plane-ce"));
const composePath = resolve(dataDirectory, "docker-compose.locked.yml");
const envPath = resolve(dataDirectory, "plane.env");
const command = process.argv[2] ?? "status";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function prepare() {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  if (await exists(composePath)) {
    const cached = await readFile(composePath, "utf8");
    if (sha256(cached) === lock.compose.lockedSha256) {
      await ensureEnvironment();
      process.stdout.write(`Plane CE ${lock.planeVersion}工件已准备:${dataDirectory}\n`);
      return;
    }
  }
  const upstream = execFileSync(
    "curl",
    [
      "-fsSL",
      "--retry",
      "4",
      "--retry-all-errors",
      "--connect-timeout",
      "10",
      "--max-time",
      "60",
      lock.compose.url,
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
  );
  if (sha256(upstream) !== lock.compose.sha256) {
    throw new Error("Plane CE Compose SHA-256与固定工件不一致");
  }
  let locked = upstream;
  for (const [source, target] of Object.entries(lock.images)) {
    if (!locked.includes(source)) throw new Error(`Plane CE Compose缺少预期镜像:${source}`);
    locked = locked.replaceAll(source, target);
  }
  if (locked.includes(":latest") || locked.includes("${APP_RELEASE")) {
    throw new Error("Plane CE Compose仍含移动镜像引用");
  }
  await writeFile(composePath, locked, { encoding: "utf8", mode: 0o600 });
  if (sha256(locked) !== lock.compose.lockedSha256) {
    throw new Error("Plane CE锁定Compose Hash与lock.json不一致");
  }
  await ensureEnvironment();
  process.stdout.write(`Plane CE ${lock.planeVersion}工件已准备:${dataDirectory}\n`);
}

async function ensureEnvironment() {
  if (!(await exists(envPath))) {
    const postgresPassword = randomBytes(24).toString("hex");
    const rabbitPassword = randomBytes(24).toString("hex");
    const minioAccessKey = randomBytes(16).toString("hex");
    const minioSecretKey = randomBytes(32).toString("hex");
    const lines = [
      `APP_RELEASE=v${lock.planeVersion}`,
      "APP_DOMAIN=localhost",
      "WEB_URL=http://localhost:8088",
      "CORS_ALLOWED_ORIGINS=http://localhost:8088",
      "LISTEN_HTTP_PORT=8088",
      "LISTEN_HTTPS_PORT=8443",
      "SITE_ADDRESS=:80",
      "USE_MINIO=1",
      "MINIO_ENDPOINT_SSL=0",
      "API_KEY_RATE_LIMIT=240/minute",
      `SECRET_KEY=${randomBytes(48).toString("hex")}`,
      `LIVE_SERVER_SECRET_KEY=${randomBytes(48).toString("hex")}`,
      "POSTGRES_USER=plane",
      `POSTGRES_PASSWORD=${postgresPassword}`,
      "POSTGRES_DB=plane",
      `DATABASE_URL=postgresql://plane:${postgresPassword}@plane-db/plane`,
      "RABBITMQ_USER=plane",
      `RABBITMQ_PASSWORD=${rabbitPassword}`,
      "RABBITMQ_VHOST=plane",
      `AMQP_URL=amqp://plane:${rabbitPassword}@plane-mq:5672/plane`,
      `AWS_ACCESS_KEY_ID=${minioAccessKey}`,
      `AWS_SECRET_ACCESS_KEY=${minioSecretKey}`,
      "AWS_S3_ENDPOINT_URL=http://plane-minio:9000",
      "AWS_S3_BUCKET_NAME=uploads",
      "CERT_EMAIL=",
      "CERT_ACME_CA=",
      "CERT_ACME_DNS=",
      "",
    ];
    await writeFile(envPath, lines.join("\n"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
}

function compose(args, stdio = "inherit") {
  execFileSync(
    "docker",
    [
      "compose",
      "--project-name",
      "chat-plane-ce",
      "--env-file",
      envPath,
      "-f",
      composePath,
      ...args,
    ],
    { cwd: dataDirectory, stdio },
  );
}

if (command === "prepare") {
  await prepare();
} else if (command === "config") {
  await prepare();
  compose(["config", "--quiet"]);
} else if (command === "up") {
  await prepare();
  compose(["pull"]);
  compose(["up", "-d", "--wait"]);
} else if (command === "down") {
  if (!(await exists(composePath)) || !(await exists(envPath))) process.exit(0);
  compose(["down"]);
} else if (command === "status") {
  if (!(await exists(composePath)) || !(await exists(envPath))) {
    process.stdout.write("Plane CE尚未准备。运行 pnpm plane-ce:prepare。\n");
  } else {
    compose(["ps"]);
  }
} else {
  throw new Error(`未知Plane CE命令:${command}`);
}
