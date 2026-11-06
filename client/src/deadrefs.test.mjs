// Static check for references to React state setters that no longer exist.
//
// Run: node --test client/src/deadrefs.test.mjs
//
// WHY THIS EXISTS: removing a feature means deleting its useState declaration,
// and it is easy to leave a setter call behind in an effect or handler. The
// bundler does not catch it — `setFoundEmails(null)` is valid JavaScript, so
// the build succeeds and the page only explodes at runtime when that code path
// is reached. That is exactly how a `ReferenceError: setFoundEmails is not
// defined` survived into a dogfood pass: the Outreach page compiled fine and
// crashed the moment a lead was selected.
//
// This is a deliberately narrow lint, not a type checker. It only answers one
// question: for every `setFoo(...)` call in a component file, is there a
// matching `useState` declaration (or a local/imported binding) for `setFoo`?

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname));

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (/\.jsx?$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Every way a `setX` name can legitimately come into scope in these files.
function declaredSetters(source) {
  const names = new Set();

  // const [x, setX] = useState(...)
  for (const m of source.matchAll(/\[\s*[\w$]+\s*,\s*([\w$]+)\s*\]\s*=\s*useState/g)) {
    names.add(m[1]);
  }
  // const setX = ... / let setX = ... / function setX(...)
  for (const m of source.matchAll(/(?:const|let|var)\s+(set[\w$]*)\s*=/g)) names.add(m[1]);
  for (const m of source.matchAll(/function\s+(set[\w$]*)\s*\(/g)) names.add(m[1]);
  // function Foo({ setX }) and ({ setX }) => — destructured props
  for (const m of source.matchAll(/\{([^{}]*)\}\s*\)?\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":").pop().trim().replace(/^\.\.\./, "");
      if (/^set[\w$]*$/.test(name)) names.add(name);
    }
  }
  // props.setX / imported bindings
  for (const m of source.matchAll(/import\s+\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (/^set[\w$]*$/.test(name)) names.add(name);
    }
  }
  // Plain parameter lists: (setX) => or function f(a, setX)
  for (const m of source.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim();
      if (/^set[\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

function calledSetters(source) {
  const calls = new Map(); // name -> first line number
  const lines = source.split("\n");
  lines.forEach((line, i) => {
    // Skip comments so prose about a removed setter is not flagged.
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    for (const m of code.matchAll(/(?<![.\w$])(set[A-Z][\w$]*)\s*\(/g)) {
      if (!calls.has(m[1])) calls.set(m[1], i + 1);
    }
  });
  return calls;
}

const files = walk(SRC);

test("every setX(...) call has a declaration in scope", () => {
  const problems = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const declared = declaredSetters(source);
    for (const [name, line] of calledSetters(source)) {
      if (!declared.has(name)) {
        problems.push(`${path.relative(SRC, file)}:${line}  ${name}(...) is called but never declared`);
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `Undeclared state setters found — these compile fine and throw at runtime:\n  ${problems.join("\n  ")}`
  );
});

test("the scanner actually detects a planted bug", () => {
  // Guard against the check silently passing because its regexes stopped
  // matching. This is the exact shape of the Outreach bug.
  const planted = `
    import { useState } from "react";
    export function Thing() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        setOpen(true);
        setGhostValue(null);
      }, []);
    }
  `;
  const declared = declaredSetters(planted);
  const called = calledSetters(planted);
  assert.ok(declared.has("setOpen"), "should see the real setter");
  assert.ok(called.has("setGhostValue"), "should see the ghost call");
  assert.ok(!declared.has("setGhostValue"), "ghost must not count as declared");
});

test("scanned a meaningful number of component files", () => {
  // If a refactor moves the sources, this test must fail loudly rather than
  // trivially passing over an empty file list.
  assert.ok(files.length >= 10, `expected to scan >=10 files, scanned ${files.length}`);
});
