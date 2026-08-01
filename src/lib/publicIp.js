import https from "node:https";
import { config } from "../config/env.js";

let cached = { ip: null, checkedAt: null, error: null };
const CACHE_TTL_MS = 10 * 60 * 1000; // the egress IP rarely changes; poll gently

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Timed out contacting IP-detection service")));
    req.on("error", reject);
  });
}

// The IP that matters for Atlas's allowlist is this server's outbound/egress IP,
// not any local/container-internal address — so we ask an external service
// rather than reading os.networkInterfaces().
export async function getPublicIp({ forceRefresh = false } = {}) {
  const isStale = !cached.checkedAt || Date.now() - cached.checkedAt > CACHE_TTL_MS;
  if (!forceRefresh && !isStale && cached.ip) {
    return cached;
  }

  try {
    const body = await fetchJson(config.publicIpCheckUrl);
    cached = { ip: body.ip, checkedAt: new Date(), error: null };
  } catch (err) {
    cached = { ip: cached.ip, checkedAt: new Date(), error: err.message };
  }
  return cached;
}
