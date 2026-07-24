type ClientCrypto = Partial<Pick<Crypto, "getRandomValues" | "randomUUID">>;

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

/**
 * Create a collision-resistant browser correlation ID on both HTTPS and the
 * temporary HTTP review entry.
 *
 * These IDs support AG-UI correlation and command idempotency. They are never
 * credentials, authorization grants or proof of identity.
 */
export function createClientId(source: ClientCrypto | undefined = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();

  if (typeof source?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    source.getRandomValues(bytes);
    return uuidFromBytes(bytes);
  }

  const entropy = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
  return `http-${entropy}`;
}
