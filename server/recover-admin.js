// Local recovery: reset the single administrator's password from the console.
//
// This is the approved recovery path (docs/AUTH.md). It is deliberately NOT an
// HTTP endpoint and has no network surface at all — the only way to invoke it
// is a shell on this machine with write access to the database file, which is
// already enough to read every record. So it grants an attacker nothing they
// did not already have, while giving the owner a way back in that does not
// involve a default password or a reset bypass in the app.
//
//   npm run recover-admin -w server
//
// It prompts twice with echo disabled, enforces the same password policy as
// setup, and invalidates every existing session so a stolen cookie cannot
// outlive the reset. Business records are never touched.

import readline from "readline";
import { Writable } from "stream";
import db from "./db.js";
import { createAuth, ADMIN_USERNAME } from "./auth.js";

// A stdout proxy that swallows the echo of whatever is typed while muted.
const muted = new Writable({
  write(chunk, encoding, callback) {
    if (!muted.muted) process.stdout.write(chunk, encoding);
    callback();
  },
});

function askHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(question);
    muted.muted = true;
    rl.question("", (answer) => {
      muted.muted = false;
      process.stdout.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error("Refusing to run without an interactive terminal.");
    console.error("Recovery requires a local operator at the console; it cannot be piped or scripted.");
    process.exit(1);
  }

  let auth;
  try {
    auth = createAuth(db);
  } catch (err) {
    console.error("Cannot open the authentication store:", err.cause?.message || err.message);
    console.error("Recovery aborted — nothing was changed.");
    process.exit(1);
  }

  const existed = auth.adminExists();
  console.log("\nGapVera — local administrator recovery");
  console.log("--------------------------------------");
  console.log(existed
    ? `This resets the password for '${ADMIN_USERNAME}' and signs out every active session.`
    : `No administrator exists yet. This creates '${ADMIN_USERNAME}'.`);
  console.log("Business records (leads, clients, invoices, documents) are not touched.\n");

  const password = await askHidden(`New password (${auth.POLICY.passwordMin}-${auth.POLICY.passwordMax} characters, spaces allowed): `);
  const policy = auth.checkPassword(password);
  if (!policy.ok) {
    console.error(policy.message || "Password rejected.");
    process.exit(1);
  }
  const confirm = await askHidden("Confirm new password: ");
  if (password !== confirm) {
    console.error("Passwords do not match. Nothing was changed.");
    process.exit(1);
  }

  try {
    if (existed) {
      // Replace the hash in place. The one-admin invariant is preserved: this
      // updates row 1, it never inserts a second identity.
      db.prepare("UPDATE auth_admin SET password_hash = ? WHERE id = 1").run(auth.hashPassword(password));
    } else {
      const result = auth.createAdmin(password, confirm);
      if (!result.ok) {
        console.error(result.message || "Could not create the administrator.");
        process.exit(1);
      }
    }
    // Any session minted under the old password dies here.
    auth.destroyAllSessions();
    auth.clearFailures();
  } catch (err) {
    console.error("Recovery failed:", err.message);
    console.error("The previous password is unchanged.");
    process.exit(1);
  }

  console.log(existed ? "\nPassword reset. All sessions were signed out." : "\nAdministrator created.");
  console.log("Start GapVera and sign in with the new password.\n");
  process.exit(0);
}

main();
