import { getPublicIp } from "../lib/publicIp.js";
import { popFlash } from "./flash.js";

// Common locals every authenticated page template needs: who's logged in, the
// navbar's IP-whitelist badge, any pending flash message, and a CSRF token for
// that page's forms (safe to reuse the same token across multiple forms on one page).
export async function baseViewContext(request, reply) {
  const publicIp = await getPublicIp();
  return {
    username: request.session.get("username"),
    publicIp,
    flash: popFlash(request),
    csrfToken: reply.generateCsrf(),
  };
}
