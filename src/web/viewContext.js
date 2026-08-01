import { getPublicIp } from "../lib/publicIp.js";
import { popFlash } from "./flash.js";
import { formatBytes, formatNumber } from "./format.js";

// Common locals every authenticated page template needs: who's logged in, the
// navbar's IP-whitelist badge, any pending flash message, a CSRF token for that
// page's forms (safe to reuse the same token across multiple forms on one page),
// and the shared display formatters.
export async function baseViewContext(request, reply) {
  const publicIp = await getPublicIp();
  return {
    username: request.session.get("username"),
    publicIp,
    flash: popFlash(request),
    csrfToken: reply.generateCsrf(),
    fmtBytes: formatBytes,
    fmtNum: formatNumber,
  };
}
