import { createServer } from "node:http";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

const captureDir = process.env.CAPTURE_DIR;
const port = Number(process.env.CAPTURE_PORT ?? 8112);

if (!captureDir) {
  throw new Error("CAPTURE_DIR is required");
}

mkdirSync(captureDir, { recursive: true });

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405).end("POST required");
    return;
  }

  const filename = new URL(request.url, `http://127.0.0.1:${port}`).pathname.slice(1);
  if (!/^[a-z0-9-]+\.png$/i.test(filename)) {
    response.writeHead(400).end("invalid filename");
    return;
  }

  const stream = createWriteStream(join(captureDir, filename), { flags: "w" });
  request.pipe(stream);
  stream.on("finish", () => response.writeHead(201).end("saved"));
  stream.on("error", () => response.writeHead(500).end("write failed"));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`capture receiver listening on ${port}\n`);
});
