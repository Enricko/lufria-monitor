// Exercise the mode-query handler from the production bundle: Vite's ES2020
// transform can corrupt xterm's prebuilt ESM while development still works.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { parseAst } from "rollup/parseAst";

const require = createRequire(import.meta.url);
globalThis.self = globalThis;
const { Terminal } = require("@xterm/xterm");
const dist = path.resolve(process.argv[2] ?? "dist");
let productionHandler;

function* nodes(node) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") yield node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) yield* nodes(child);
    } else if (value && typeof value === "object") yield* nodes(value);
  }
}

// Follow the current HTML's imports so old cached chunks left in assets cannot
// accidentally pass or fail a check of the deployed version.
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const pending = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+\.js)["']/g)]
  .map((match) => path.join(dist, match[1].replace(/^\//, "")));
const visited = new Set();
while (pending.length) {
  const file = pending.shift();
  if (visited.has(file)) continue;
  visited.add(file);
  const source = fs.readFileSync(file, "utf8");
  const ast = [...nodes(parseAst(source))];
  for (const node of ast) {
    if ((node.type === "ImportDeclaration" || node.type === "ImportExpression") && node.source?.value?.startsWith(".")) {
      pending.push(path.resolve(path.dirname(file), node.source.value));
    }
  }
  const method = ast.find(
    (node) => node.type === "MethodDefinition" && node.key.name === "requestMode",
  );
  if (!method) continue;
  const escapeNames = [...new Set([...nodes(method)].filter(
    (node) => node.type === "MemberExpression" && node.property.name === "ESC" && node.object.type === "Identifier",
  ).map((node) => node.object.name))];
  // Strict mode matches an ESM bundle, including undeclared-variable errors.
  productionHandler = new Function(...escapeNames,
    `"use strict"; return ({${source.slice(method.start, method.end)}}).requestMode;`,
  )(...escapeNames.map(() => ({ ESC: "\x1b" })));
  break;
}
assert.ok(productionHandler, "production xterm mode-query handler must be present");

const terminal = new Terminal({ cols: 157, rows: 33 });
const input = terminal._core._inputHandler;
input.requestMode = productionHandler;
const replies = [];
terminal.onData((data) => replies.push(data));
try {
  // OpenCode probes all six modes before drawing its first frame.
  input.parse("\x1b[?1016$p\x1b[?2027$p\x1b[?2031$p\x1b[?1004$p\x1b[?2004$p\x1b[?2026$p");
  assert.deepEqual(replies, [
    "\x1b[?1016;2$y", "\x1b[?2027;0$y", "\x1b[?2031;0$y",
    "\x1b[?1004;2$y", "\x1b[?2004;2$y", "\x1b[?2026;2$y",
  ]);
  input.parse("\x1b[4h\x1b[4$p\x1b[?2004h\x1b[?2004$p\x1b[?1049h\x1b[?1049$p");
  assert.deepEqual(replies.slice(-3), ["\x1b[4;1$y", "\x1b[?2004;1$y", "\x1b[?1049;1$y"]);
  const frame = Buffer.from("\x1b[?2026h\x1b[2J\x1b[HOpenCode\r\n\x1b[38;2;92;156;245m┃ Ask anything…\x1b[0m\x1b[?2026l");
  for (let offset = 0; offset < frame.length; offset += 3) input.parse(frame.subarray(offset, offset + 3));
  assert.equal(terminal.buffer.active.type, "alternate");
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "OpenCode");
  assert.equal(terminal.buffer.active.getLine(1).translateToString(true), "┃ Ask anything…");
  assert.equal(terminal._core.coreService.decPrivateModes.synchronizedOutput, false);

  if (process.argv[3]) {
    const recording = fs.readFileSync(process.argv[3]);
    const start = recording.indexOf(10) + 1;
    const end = recording.lastIndexOf(Buffer.from("\x1b[?1049l"));
    assert.ok(end > start, "recording must contain an alternate-screen session");
    terminal.reset();
    for (let offset = start; offset < end; offset += 257) input.parse(recording.subarray(offset, Math.min(end, offset + 257)));
    const screen = Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(row).translateToString(true)).join("\n");
    assert.ok(screen.includes("Ask anything"), "recorded OpenCode screen must render after its startup probes");
    console.log("Recorded OpenCode startup and screen: passed");
  }
  console.log("Production terminal mode queries and fragmented TUI output: passed");
} finally {
  terminal.dispose();
}
