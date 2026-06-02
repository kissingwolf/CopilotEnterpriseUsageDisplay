#!/usr/bin/env node
/**
 * Generate a bcrypt hash for ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   node scripts/hash-admin-password.js 'your-strong-password'
 *   node scripts/hash-admin-password.js          # interactive (hidden) prompt
 *
 * Then paste the printed line into your .env file.
 */
"use strict";

const bcrypt = require("bcryptjs");

const COST = 12;

function hashAndPrint(password) {
  if (!password || password.length < 8) {
    console.error("ERROR: password must be at least 8 characters.");
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, COST);
  console.log("");
  console.log("Add this line to your .env file:");
  console.log("");
  console.log(`ADMIN_PASSWORD_HASH=${hash}`);
  console.log("");
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(question);

    let buf = "";
    const wasRaw = stdin.isRaw === true;
    stdin.resume();
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.setEncoding("utf8");

    const onData = (ch) => {
      switch (ch) {
        case "\n":
        case "\r":
        case "\u0004": /* Ctrl-D */
          if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          resolve(buf);
          break;
        case "\u0003": /* Ctrl-C */
          if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          reject(new Error("Aborted"));
          break;
        case "\u007f": /* Backspace */
          buf = buf.slice(0, -1);
          break;
        default:
          buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const arg = process.argv[2];
  if (arg) {
    hashAndPrint(arg);
    return;
  }
  try {
    const password = await promptHidden("Enter admin password (input hidden): ");
    const confirm = await promptHidden("Confirm admin password: ");
    if (password !== confirm) {
      console.error("ERROR: passwords do not match.");
      process.exit(1);
    }
    hashAndPrint(password);
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(1);
  }
}

main();
