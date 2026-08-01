import "dotenv/config";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { connectCatalog, closeCatalog } from "../src/lib/catalogDb.js";
import { createUser } from "../src/services/userService.js";

// There is no self-registration page by design — this is the only way to
// create a login. Run non-interactively as `node scripts/create-admin.js
// <username> <password>`, or interactively with no arguments.
async function main() {
  let [username, password] = process.argv.slice(2);

  if (!username || !password) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    username = (await rl.question("Admin username: ")).trim();
    password = await rl.question("Admin password: ");
    rl.close();
  }

  if (!username || !password) {
    console.error("Username and password are required.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await connectCatalog();
  try {
    await createUser(username, password);
    console.log(`Created admin user "${username}".`);
  } finally {
    await closeCatalog();
  }
}

main().catch((err) => {
  console.error("Failed to create admin user:", err.message);
  process.exit(1);
});
