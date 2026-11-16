"use strict";
const fs = require("node:fs");
const { randomBytes } = require("node:crypto");
function readPrivate(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.size > 16384 ||
      st.mode & 0o077 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw new Error("PRIVATE_FILE_REQUIRED");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
function writePrivate(path, value, initial = false) {
  const temporary = initial
    ? path
    : `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!initial) fs.renameSync(temporary, path);
}
async function locked(path, work) {
  const lock = `${path}.lock`;
  const fd = fs.openSync(lock, "wx", 0o600);
  try {
    return await work();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
module.exports = { readPrivate, writePrivate, locked };
