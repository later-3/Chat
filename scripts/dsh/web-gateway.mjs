import { createServer, request as httpRequest } from "node:http";

import { validateCodeServerSocketEvidence } from "../workbench/fixed-code-server.mjs";

export const PUBLIC_WEB_HOST = "127.0.0.1";
export const PUBLIC_WEB_PORT = 43110;
export const DSH_INTERNAL_WEB_HOST = "127.0.0.1";
export const DSH_INTERNAL_WEB_PORT = 43114;
export const CODE_WORKBENCH_PUBLIC_PREFIX = "/workbench/code";

const CONNECT_TIMEOUT_MS = 5_000;
const STANDARD_HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function headerValue(value) {
  return typeof value === "string" ? value : undefined;
}

function publicAuthority(headers) {
  const host = headerValue(headers.host);
  if (host === undefined)
    throw Object.assign(new Error("Host header is required"), { status: 400 });
  let authority;
  try {
    authority = new URL(`http://${host}`);
  } catch {
    throw Object.assign(new Error("Host header is invalid"), { status: 400 });
  }
  if (
    authority.port !== String(PUBLIC_WEB_PORT) ||
    !["127.0.0.1", "localhost"].includes(authority.hostname) ||
    authority.username !== "" ||
    authority.password !== "" ||
    authority.pathname !== "/" ||
    authority.search !== "" ||
    authority.hash !== ""
  ) {
    throw Object.assign(new Error("Workbench is loopback-only"), { status: 403 });
  }
  return authority;
}

/** Workbench无独立浏览器凭据；必须在Gateway保留原始同源边界后才可改写Origin。 */
export function assertPublicWorkbenchRequest(req) {
  const authority = publicAuthority(req.headers);
  if (authority.hostname !== "localhost") {
    throw Object.assign(new Error("Workbench must use the isolated localhost origin"), {
      status: 403,
    });
  }
  const fetchSite = headerValue(req.headers["sec-fetch-site"]);
  const origin = headerValue(req.headers.origin);
  if (fetchSite === "cross-site") {
    const mode = headerValue(req.headers["sec-fetch-mode"]);
    const destination = headerValue(req.headers["sec-fetch-dest"]);
    const pathname = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
    const referer = headerValue(req.headers.referer);
    let trustedBootstrapReferer = false;
    if (referer !== undefined) {
      try {
        const parsed = new URL(referer);
        trustedBootstrapReferer =
          parsed.origin === `http://${PUBLIC_WEB_HOST}:${String(PUBLIC_WEB_PORT)}`;
      } catch {
        trustedBootstrapReferer = false;
      }
    }
    const safeBootstrap =
      (req.method === "GET" || req.method === "HEAD") &&
      mode === "navigate" &&
      (destination === "iframe" || destination === "document") &&
      origin === undefined &&
      trustedBootstrapReferer &&
      (pathname === CODE_WORKBENCH_PUBLIC_PREFIX ||
        pathname === `${CODE_WORKBENCH_PUBLIC_PREFIX}/`);
    if (!safeBootstrap) {
      throw Object.assign(new Error("Cross-site Workbench request rejected"), { status: 403 });
    }
  } else if (
    fetchSite !== undefined &&
    fetchSite !== "same-origin" &&
    fetchSite !== "same-site" &&
    fetchSite !== "none"
  ) {
    throw Object.assign(new Error("Cross-site Workbench request rejected"), { status: 403 });
  }
  if (origin !== undefined) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw Object.assign(new Error("Origin header is invalid"), { status: 403 });
    }
    if (parsed.origin !== authority.origin || parsed.href !== `${parsed.origin}/`) {
      throw Object.assign(new Error("Origin must match the public Workbench origin"), {
        status: 403,
      });
    }
  }
}

export function isWorkbenchPath(rawUrl) {
  const pathname = new URL(rawUrl ?? "/", "http://gateway.invalid").pathname;
  return (
    pathname === CODE_WORKBENCH_PUBLIC_PREFIX ||
    pathname.startsWith(`${CODE_WORKBENCH_PUBLIC_PREFIX}/`)
  );
}

export function rewriteWorkbenchPath(rawUrl) {
  const parsed = new URL(rawUrl ?? "/", "http://gateway.invalid");
  if (!isWorkbenchPath(rawUrl)) throw new Error("URL is outside the managed Workbench prefix");
  const suffix = parsed.pathname.slice(CODE_WORKBENCH_PUBLIC_PREFIX.length);
  return `${suffix === "" ? "/" : suffix}${parsed.search}`;
}

function cleanHeaders(source, keepUpgrade) {
  const headers = { ...source };
  const named = headerValue(headers.connection)
    ?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...STANDARD_HOP_BY_HOP, ...(named ?? [])]) delete headers[name];
  if (keepUpgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
  }
  return headers;
}

function upstreamFor(req, targets) {
  const authority = publicAuthority(req.headers);
  if (authority.hostname === "localhost") {
    if (!isWorkbenchPath(req.url)) {
      throw Object.assign(new Error("localhost origin is reserved for Code Workbench"), {
        status: 403,
      });
    }
    assertPublicWorkbenchRequest(req);
    if (targets.workbench === undefined) {
      throw Object.assign(new Error("Code Workbench is disabled"), { status: 503 });
    }
    return {
      kind: "workbench",
      socketPath: targets.workbench.socketPath,
      path: rewriteWorkbenchPath(req.url),
    };
  }
  if (isWorkbenchPath(req.url)) {
    throw Object.assign(new Error("Use the isolated localhost Workbench origin"), {
      status: 421,
      redirect: `http://localhost:${String(PUBLIC_WEB_PORT)}${req.url ?? `${CODE_WORKBENCH_PUBLIC_PREFIX}/`}`,
    });
  }
  return {
    kind: "dsh",
    host: targets.dsh.host,
    port: targets.dsh.port,
    path: req.url ?? "/",
  };
}

function upstreamHeaders(req, upstream, keepUpgrade) {
  const headers = cleanHeaders(req.headers, keepUpgrade);
  if (upstream.kind === "workbench") {
    // Unix socket没有可被浏览器寻址的authority。这个固定内部authority仅用于满足
    // code-server自身的Host/Origin一致性检查，绝不承担访问控制。
    headers.host = "localhost";
    if (headers.origin !== undefined) headers.origin = "http://localhost";
    // code-server不需要Referer。删除比解析/改写更安全：恶意值不能越过Gateway，
    // 也不会因为非Workbench路径或畸形URL在请求回调中抛出同步异常。
    delete headers.referer;
  }
  return headers;
}

function startConnectDeadline(proxy, onTimeout) {
  let timer;
  proxy.once("socket", (socket) => {
    if (!socket.connecting) return;
    timer = setTimeout(onTimeout, CONNECT_TIMEOUT_MS);
    timer.unref();
    socket.once("connect", () => clearTimeout(timer));
  });
  proxy.once("close", () => clearTimeout(timer));
}

function writeGatewayError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = `${message}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function rewriteLocation(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("/")) return `${CODE_WORKBENCH_PUBLIC_PREFIX}${value}`;
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "localhost" && parsed.port === "") {
      return `${CODE_WORKBENCH_PUBLIC_PREFIX}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Relative Location values already resolve beneath /workbench/code/.
  }
  return value;
}

function upstreamConnection(upstream) {
  return upstream.kind === "workbench"
    ? { socketPath: upstream.socketPath }
    : { hostname: upstream.host, port: upstream.port };
}

function responseHeaders(headers, kind) {
  const result = cleanHeaders(headers, false);
  if (kind === "workbench") {
    if (result.location !== undefined) result.location = rewriteLocation(result.location);
    // code-server的Service Worker只能控制Hosted Workbench，不能接管DSH主界面。
    if (result["service-worker-allowed"] !== undefined) {
      result["service-worker-allowed"] = `${CODE_WORKBENCH_PUBLIC_PREFIX}/`;
    }
    const contentType = headerValue(result["content-type"]);
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/html") {
      const current = headerValue(result["content-security-policy"]);
      const directives = (current ?? "")
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => directive !== "" && !/^frame-ancestors(?:\s|$)/iu.test(directive));
      directives.push(`frame-ancestors http://${PUBLIC_WEB_HOST}:${String(PUBLIC_WEB_PORT)}`);
      // 上游升级即使把frame-ancestors放宽为*，Gateway仍无条件收紧到DSH主Origin。
      result["content-security-policy"] = directives.join("; ");
    }
  }
  return result;
}

function handleHttp(req, res, logger, targets) {
  let upstream;
  try {
    upstream = upstreamFor(req, targets);
  } catch (error) {
    if (typeof error?.redirect === "string" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(302, { location: error.redirect, "cache-control": "no-store" });
      res.end();
      return;
    }
    writeGatewayError(
      res,
      Number(error?.status) || 400,
      error instanceof Error ? error.message : "Bad request",
    );
    return;
  }
  const proxy = httpRequest(
    {
      ...upstreamConnection(upstream),
      method: req.method,
      path: upstream.path,
      headers: upstreamHeaders(req, upstream, false),
    },
    (incoming) => {
      res.writeHead(
        incoming.statusCode ?? 502,
        incoming.statusMessage,
        responseHeaders(incoming.headers, upstream.kind),
      );
      incoming.once("aborted", () => res.destroy());
      incoming.once("error", () => res.destroy());
      res.once("close", () => {
        if (res.writableFinished) return;
        incoming.destroy();
        proxy.destroy();
      });
      incoming.pipe(res);
    },
  );
  let failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    logger(error);
    proxy.destroy();
    writeGatewayError(
      res,
      502,
      `${upstream.kind === "workbench" ? "Code Workbench" : "DSH"} upstream unavailable`,
    );
  };
  startConnectDeadline(proxy, () => fail(new Error(`${upstream.kind} connect timeout`)));
  proxy.once("error", fail);
  req.once("aborted", () => proxy.destroy());
  req.pipe(proxy);
}

function rawResponseHead(response, headers) {
  const lines = [
    `HTTP/${response.httpVersion} ${String(response.statusCode ?? 502)} ${response.statusMessage ?? ""}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      lines.push(`${name}: ${String(item)}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function writeSocketError(socket, status, message) {
  if (!socket.writable) return socket.destroy();
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${String(status)} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function handleUpgrade(req, socket, head, logger, targets) {
  // Upgraded sockets no longer have ServerResponse supervision; every side of the
  // tunnel must own an error listener or a routine browser reconnect can crash Host.
  socket.once("error", (error) => {
    logger(error);
    socket.destroy();
  });
  let upstream;
  try {
    upstream = upstreamFor(req, targets);
  } catch (error) {
    writeSocketError(
      socket,
      Number(error?.status) || 400,
      error instanceof Error ? error.message : "Bad request",
    );
    return;
  }
  const proxy = httpRequest({
    ...upstreamConnection(upstream),
    method: req.method ?? "GET",
    path: upstream.path,
    headers: upstreamHeaders(req, upstream, true),
  });
  let settled = false;
  const fail = (error) => {
    if (settled) return;
    settled = true;
    logger(error);
    proxy.destroy();
    writeSocketError(
      socket,
      502,
      `${upstream.kind === "workbench" ? "Code Workbench" : "DSH"} WebSocket unavailable`,
    );
  };
  startConnectDeadline(proxy, () => fail(new Error(`${upstream.kind} websocket connect timeout`)));
  proxy.once("upgrade", (response, upstreamSocket, upstreamHead) => {
    if (settled) return upstreamSocket.destroy();
    settled = true;
    upstreamSocket.once("error", (error) => {
      logger(error);
      socket.destroy();
      upstreamSocket.destroy();
    });
    socket.write(rawResponseHead(response, cleanHeaders(response.headers, true)));
    if (upstreamHead.byteLength > 0) socket.write(upstreamHead);
    if (head.byteLength > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  proxy.once("response", (response) => {
    if (settled) return;
    settled = true;
    socket.write(rawResponseHead(response, responseHeaders(response.headers, upstream.kind)));
    response.pipe(socket);
  });
  proxy.once("error", fail);
  socket.once("close", () => proxy.destroy());
  proxy.end();
}

/**
 * 唯一浏览器端口由本进程Gateway拥有。DSH只监听固定loopback内部端口，code-server只
 * 监听0600 Unix socket；
 * Gateway不生成目标地址，也不接受用户指定upstream，避免成为开放代理。
 */
export async function startWebGateway(options = {}) {
  const logger = options.logger ?? (() => undefined);
  // targets/publicPort只是模块级测试接缝；生产launcher不传入，目标端口绝不来自环境或请求。
  let targets = options.targets;
  if (targets === undefined) {
    const workbenchEnabled = process.env.CHAT_CODE_WORKBENCH_ENABLED !== "0";
    const workbench = workbenchEnabled
      ? Object.freeze({ socketPath: validateCodeServerSocketEvidence().socketPath })
      : undefined;
    targets = Object.freeze({
      dsh: Object.freeze({ host: DSH_INTERNAL_WEB_HOST, port: DSH_INTERNAL_WEB_PORT }),
      workbench,
    });
  }
  const publicPort = options.publicPort ?? PUBLIC_WEB_PORT;
  const sockets = new Set();
  const server = createServer((req, res) => handleHttp(req, res, logger, targets));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head, logger, targets));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(publicPort, PUBLIC_WEB_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  let closePromise;
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error("DSH Gateway did not receive a TCP address");
  }
  return Object.freeze({
    host: PUBLIC_WEB_HOST,
    port: address.port,
    close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  });
}
