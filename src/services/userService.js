import bcrypt from "bcryptjs";
import { insertUser, findUserByUsername } from "../repositories/usersRepo.js";
import { insertAuditEntry } from "../repositories/auditRepo.js";

const BCRYPT_ROUNDS = 12;

// There is no self-registration flow by design (only login) — admin accounts
// are created via `npm run create-admin`, which calls this directly.
export async function createUser(username, password) {
  const existing = await findUserByUsername(username);
  if (existing) throw new Error(`User "${username}" already exists`);

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const doc = { username, passwordHash, createdAt: new Date() };
  return insertUser(doc);
}

export async function verifyCredentials(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;
  return user;
}

export async function recordLogin(username, ok, ip) {
  await insertAuditEntry({
    actor: username || "unknown",
    action: ok ? "login" : "login-failed",
    detail: { ip },
  });
}
