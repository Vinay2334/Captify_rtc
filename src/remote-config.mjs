// Over-the-air configuration for backend/redirect URLs.
//
// The extension fetches a JSON document (data only, never logic) and uses
// it to override the baked-in defaults. Packaged fallback:
// remote-config/extension-config.json is copied verbatim into dist/ and used
// when the fetch fails or the device is offline. Unknown fields are dropped;
// invalid values fall back to the packaged defaults. URL overrides must be
// https: (http: is accepted for loopback only); the full rule lives in
// validateRemoteConfig, which the overlay's classic script mirrors.

// Public config document. Changing values here needs no extension release —
// edit the hosted JSON instead. The host must stay in manifest.json
// host_permissions + connect-src or the fetch is blocked.
export const REMOTE_CONFIG_URL = "https://floral-dust-d2f5.vinaybhardwaj2334.workers.dev/extension-config.json";

// chrome.storage.local key for the last validated remote document.
export const REMOTE_CONFIG_STORAGE_KEY = "captifyRemoteConfig";

// One remote round-trip must fail fast into the fallback path, never hang
// session start or a quota read.
export const REMOTE_CONFIG_TIMEOUT_MS = 8000;

// Local development switch. Set to true to force the packaged localhost
// backend everywhere: loadRemoteConfig returns null and every resolve*
// helper falls through to its localhost fallback. No hosted fetch, no cache
// read. Flip back to false before publishing.
export const DEV_FORCE_LOCAL_BACKEND = false;

const MAX_ICE_SERVERS = 8;

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "127.0.0.1" ||
    host.startsWith("127.")
  );
}

function asAllowedUrl(value) {
  if (typeof value !== "string" || !value) return null;
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return null;
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return null;
  }
  return url;
}

// Data-only validation: returns a sanitized copy with known keys, or null
// when nothing usable survives. Never throws on hostile input.
export function validateRemoteConfig(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  if (typeof obj.version === "number") out.version = obj.version;

  for (const key of [
    "backend_base_url",
    "signal_url",
    "overlay_api_prefix",
    "site_url",
    "supabase_url",
  ]) {
    const url = asAllowedUrl(obj[key]);
    if (url) out[key] = key === "signal_url" || key === "overlay_api_prefix"
      ? url.toString()
      : url.toString().replace(/\/+$/, "");
  }

  if (typeof obj.supabase_anon_key === "string" && obj.supabase_anon_key) {
    out.supabase_anon_key = obj.supabase_anon_key;
  }

  if (Array.isArray(obj.ice_servers)) {
    const servers = [];
    for (const entry of obj.ice_servers) {
      if (!entry || typeof entry !== "object") continue;
      const urls = entry.urls;
      const okUrls = typeof urls === "string"
        ? urls
        : Array.isArray(urls) && urls.every((u) => typeof u === "string");
      if (!okUrls) continue;
      const server = { urls };
      if (typeof entry.username === "string") server.username = entry.username;
      if (typeof entry.credential === "string") server.credential = entry.credential;
      servers.push(server);
      if (servers.length >= MAX_ICE_SERVERS) break;
    }
    if (servers.length) out.ice_servers = servers;
  }

  if (
    typeof obj.data_channel_label === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(obj.data_channel_label)
  ) {
    out.data_channel_label = obj.data_channel_label;
  }

  return Object.keys(out).length ? out : null;
}

// Resolution order per key: explicit field -> derived from backend_base_url
// -> packaged default. Derivation keeps the three backend URLs in sync when
// the document only sets the base.
export function resolveBackendBaseUrl(remote, fallback) {
  return remote?.backend_base_url || fallback;
}

export function resolveSignalUrl(remote, fallback) {
  if (remote?.signal_url) return `${remote.backend_base_url}/api/v1/transcription/webrtc/offer`;
  if (remote?.backend_base_url) {
    return `${remote.backend_base_url}/api/v1/transcription/webrtc/offer`;
  }
  return fallback;
}

export function resolveOverlayApiPrefix(remote, fallback) {
  if (remote?.backend_base_url) return `${remote.backend_base_url}/api/`;
  return fallback;
}

export function resolveSiteUrl(remote, fallback) {
  return remote?.site_url || fallback;
}

export function resolveIceServers(remote, fallback) {
  return remote?.ice_servers || fallback;
}

export function resolveDataChannelLabel(remote, fallback) {
  return remote?.data_channel_label || fallback;
}

export function resolveSupabaseUrl(remote, fallback) {
  return remote?.supabase_url || fallback;
}

export function resolveSupabaseAnonKey(remote, fallback) {
  return remote?.supabase_anon_key || fallback;
}

// Fetch the hosted document and validate it. Throws on network/HTTP errors
// and returns null when the document fails validation (both cases mean the
// caller must use cache or fallback).
export async function fetchRemoteConfig({
  fetchImpl = globalThis.fetch,
  timeoutMs = REMOTE_CONFIG_TIMEOUT_MS,
} = {}) {
  const res = await fetchImpl(REMOTE_CONFIG_URL, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Remote config request failed (${res.status})`);
  return validateRemoteConfig(await res.json());
}

export async function readCachedRemoteConfig(storage) {
  try {
    const res = await storage?.local?.get(REMOTE_CONFIG_STORAGE_KEY);
    return validateRemoteConfig(res?.[REMOTE_CONFIG_STORAGE_KEY]);
  } catch (e) {
    return null;
  }
}

export async function writeCachedRemoteConfig(storage, config) {
  try {
    if (config) await storage?.local?.set({ [REMOTE_CONFIG_STORAGE_KEY]: config });
  } catch (e) {
    // Storage unavailable — memory/bundled values still apply.
  }
}

// Packaged fallback: extension-config.json copied into dist/ by
// vite.config.mjs. Same validation as the hosted document.
export async function readBundledFallback({ fetchImpl = globalThis.fetch, getUrl } = {}) {
  try {
    const url = getUrl("extension-config.json");
    if (!url) return null;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    return validateRemoteConfig(await res.json());
  } catch (e) {
    return null;
  }
}

// Load order: dev bypass -> network (when refresh) -> storage cache ->
// packaged fallback. Never throws; null means dev mode, or every source
// failed, and the caller must use its baked-in (localhost) defaults.
export async function loadRemoteConfig({
  fetchImpl = globalThis.fetch,
  storage = globalThis.chrome?.storage,
  getUrl = (path) => globalThis.chrome?.runtime?.getURL(path),
  refresh = false,
} = {}) {
  if (DEV_FORCE_LOCAL_BACKEND) return null;
  if (refresh) {
    try {
      const remote = await fetchRemoteConfig({ fetchImpl });
      if (remote) {
        await writeCachedRemoteConfig(storage, remote);
        return remote;
      }
    } catch (e) {
      // Offline or unreachable — fall through to cache, then fallback.
    }
  }
  const cached = await readCachedRemoteConfig(storage);
  if (cached) return cached;
  return readBundledFallback({ fetchImpl, getUrl });
}
