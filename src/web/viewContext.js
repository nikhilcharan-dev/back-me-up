import { getPublicIp } from "../lib/publicIp.js";
import { popFlash } from "./flash.js";
import { formatBytes, formatNumber, formatDuration } from "./format.js";
import { serverTimeZone } from "./schedulePresets.js";

// Common locals every authenticated page template needs: who's logged in, the
// navbar's IP-whitelist badge, any pending flash message, a CSRF token for that
// page's forms (safe to reuse the same token across multiple forms on one page),
// the shared display formatters, and the VM's own clock (bottom-right widget,
// partials/foot.ejs) — node-cron schedules fire in this timezone, not the
// browser's, so seeing it at a glance is the point.
export async function baseViewContext(request, reply) {
  const publicIp = await getPublicIp();
  return {
    username: request.session.get("username"),
    publicIp,
    flash: popFlash(request),
    csrfToken: reply.generateCsrf(),
    fmtBytes: formatBytes,
    fmtNum: formatNumber,
    fmtDuration: formatDuration,
    serverEpochMs: Date.now(),
    serverTimeZone: serverTimeZone(),
  };
}
