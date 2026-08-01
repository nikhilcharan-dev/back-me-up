import { findUserById } from "../repositories/usersRepo.js";

// preHandler for every authenticated web page. Signing in is the only path to
// an account (no self-registration) — see scripts/create-admin.js.
export async function requireAuth(request, reply) {
  const userId = request.session.get("userId");
  if (!userId) {
    return reply.redirect("/login");
  }
  const user = await findUserById(userId);
  if (!user) {
    request.session.delete();
    return reply.redirect("/login");
  }
  request.currentUser = user;
}

// Guards the JSON /api/* surface with the same session cookie as the SSR UI
// (the restore-status page's browser-side polling relies on this) — otherwise
// the API would be a wide-open bypass around the login screen.
export async function requireApiAuth(request, reply) {
  const userId = request.session.get("userId");
  if (!userId) {
    return reply.code(401).send({ error: "Authentication required" });
  }
}
