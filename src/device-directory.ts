import { readFile, stat } from "node:fs/promises";

export const DEVICE_DIRECTORY_VERSION = 1;
export const MAX_DEVICE_COUNT = 32;
export const MAX_DEVICE_CONFIG_BYTES = 64 * 1024;

const DEVICE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CONFIG_KEYS = new Set(["$schema", "version", "devices"]);
const DEVICE_KEYS = new Set(["id", "name", "url"]);

export interface DeviceDescriptor {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export interface DeviceDirectoryDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface DeviceDirectoryResponse {
  readonly version: typeof DEVICE_DIRECTORY_VERSION;
  readonly currentDeviceId: string;
  readonly devices: readonly DeviceDescriptor[];
  readonly diagnostics: readonly DeviceDirectoryDiagnostic[];
  readonly selectionMode: "direct";
  readonly gatewayUrl: null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseDevice(value: unknown): DeviceDescriptor | null {
  if (!isRecord(value) || !hasOnlyKeys(value, DEVICE_KEYS)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const url = normalizeUrl(value.url);
  if (!DEVICE_ID_PATTERN.test(id) || name === "" || name.length > 80 || /\p{Cc}/u.test(name) || !url) return null;
  return { id, name, url };
}

function diagnostic(code: string, message: string): DeviceDirectoryDiagnostic {
  return { code, message };
}

function fallbackDirectory(
  currentUrl: string,
  diagnostics: readonly DeviceDirectoryDiagnostic[] = [],
): DeviceDirectoryResponse {
  return {
    version: DEVICE_DIRECTORY_VERSION,
    currentDeviceId: "local",
    devices: [{ id: "local", name: "Chat", url: currentUrl }],
    diagnostics,
    selectionMode: "direct",
    gatewayUrl: null,
  };
}

function resolveCurrentUrl(preferredCurrentUrl: string, requestOrigin: string): string {
  return normalizeUrl(preferredCurrentUrl) ?? normalizeUrl(requestOrigin) ?? "http://127.0.0.1";
}

/**
 * Converts private Chat Home configuration into the narrow browser contract.
 * SSH, account, filesystem, credential, and relay fields are rejected rather
 * than accidentally projected through `/api/devices`.
 */
export function buildDeviceDirectory(
  input: unknown,
  preferredCurrentUrl: string,
  requestOrigin: string,
): DeviceDirectoryResponse {
  const currentUrl = resolveCurrentUrl(preferredCurrentUrl, requestOrigin);
  if (input === undefined) return fallbackDirectory(currentUrl);
  if (!isRecord(input) || !hasOnlyKeys(input, CONFIG_KEYS)) {
    return fallbackDirectory(currentUrl, [diagnostic(
      "invalid-device-config",
      "Device configuration must contain only $schema, version, and devices",
    )]);
  }
  if (input.version !== DEVICE_DIRECTORY_VERSION || !Array.isArray(input.devices)) {
    return fallbackDirectory(currentUrl, [diagnostic(
      "invalid-device-config",
      `Device configuration version must be ${DEVICE_DIRECTORY_VERSION} and devices must be an array`,
    )]);
  }

  const diagnostics: DeviceDirectoryDiagnostic[] = [];
  if (input.devices.length > MAX_DEVICE_COUNT) {
    diagnostics.push(diagnostic("device-limit-exceeded", `Only the first ${MAX_DEVICE_COUNT} devices were considered`));
  }
  const devices: DeviceDescriptor[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const [index, rawDevice] of input.devices.slice(0, MAX_DEVICE_COUNT).entries()) {
    const device = parseDevice(rawDevice);
    if (!device) {
      diagnostics.push(diagnostic("invalid-device", `devices[${index}] is invalid`));
      continue;
    }
    if (ids.has(device.id) || urls.has(device.url)) {
      diagnostics.push(diagnostic("duplicate-device", `devices[${index}] duplicates an existing id or URL`));
      continue;
    }
    ids.add(device.id);
    urls.add(device.url);
    devices.push(device);
  }

  const currentIndex = devices.findIndex((device) => device.url === currentUrl);
  let current: DeviceDescriptor;
  if (currentIndex === -1) {
    current = { id: "local", name: "Chat", url: currentUrl };
    if (devices.length > 0) {
      diagnostics.push(diagnostic(
        "current-device-not-configured",
        "The current Chat URL is not present in the configured device directory",
      ));
    }
  } else {
    current = devices[currentIndex]!;
    devices.splice(currentIndex, 1);
  }

  return {
    version: DEVICE_DIRECTORY_VERSION,
    currentDeviceId: current.id,
    devices: [current, ...devices],
    diagnostics,
    selectionMode: "direct",
    gatewayUrl: null,
  };
}

export async function loadDeviceDirectory(
  configPath: string,
  preferredCurrentUrl: string,
  requestOrigin: string,
): Promise<DeviceDirectoryResponse> {
  const currentUrl = resolveCurrentUrl(preferredCurrentUrl, requestOrigin);
  let content: string;
  try {
    const metadata = await stat(configPath);
    if (!metadata.isFile() || metadata.size > MAX_DEVICE_CONFIG_BYTES) {
      return fallbackDirectory(currentUrl, [diagnostic(
        "invalid-device-config",
        "Device configuration is not a bounded regular file",
      )]);
    }
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return fallbackDirectory(currentUrl);
    return fallbackDirectory(currentUrl, [diagnostic(
      "unreadable-device-config",
      "Device configuration could not be read",
    )]);
  }

  try {
    return buildDeviceDirectory(JSON.parse(content) as unknown, preferredCurrentUrl, requestOrigin);
  } catch {
    return fallbackDirectory(currentUrl, [diagnostic(
      "invalid-device-config",
      "Device configuration is not valid JSON",
    )]);
  }
}
