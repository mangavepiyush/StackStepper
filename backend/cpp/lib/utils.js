const crypto = require("crypto");

function createId() {
  return crypto.randomBytes(8).toString("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text, maxLength) {
  const input = typeof text === "string" ? text : String(text);
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength - 3)}...`;
}

module.exports = {
  createId,
  delay,
  truncate,
};
