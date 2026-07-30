"use strict";

// Local recovery tool. Run this only on the computer that holds the private
// data folder, after stopping the billing server.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline/promises");

const DATA_DIR = path.resolve(process.env.STUDIO_DATA_DIR || path.join(__dirname, "data"));
const USERS_FILE = path.join(DATA_DIR, "users.json");

function validPassword(value) {
  return typeof value === "string" && value.length >= 12 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);
}

function passwordHash(password, salt = crypto.randomBytes(16).toString("base64url")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt}:${derivedKey.toString("base64url")}`);
    });
  });
}

async function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(question);
  prompt.close();
  return answer.trim();
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("Run this command directly in PowerShell."));
    let value = "";
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Password reset cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\b" || character === "\u007f") {
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        value += character;
        process.stdout.write("*");
      }
    };
    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const email = (await ask("Account email to reset: ")).toLowerCase();
  const password = await askHidden("New password (hidden): ");
  const confirmation = await askHidden("Confirm new password: ");
  if (password !== confirmation) throw new Error("Passwords do not match. Nothing was changed.");
  if (!validPassword(password)) throw new Error("Use a 12+ character password with uppercase, lowercase, and a number.");

  const users = JSON.parse(await fs.readFile(USERS_FILE, "utf8"));
  const user = users.find((item) => item.email === email);
  if (!user) throw new Error("No staff account uses that email address.");
  user.passwordHash = await passwordHash(password);
  const temporary = `${USERS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fs.rename(temporary, USERS_FILE);
  process.stdout.write(`Password reset for ${user.email}. Start the server and sign in with the new password.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
