'use strict';
// For the browser suites: copies application modules, and everything they
// import, into a fixture extension as native ES modules under the same
// relative paths (`<destination>/src/...`). Sources use extensionless
// specifiers that webpack resolves; a browser does not, so each relative
// import is given its `.js`. The code is otherwise unchanged.
//
// Each suite used to copy a fixed list of files and rewrite named imports by
// hand. That list went stale as soon as a module gained an import, and the
// suite then failed at load with no hint of which import was missing.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const relative = /(\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
const bare = /^\s*import\b[^'"]*\bfrom\s*(['"])([^.'"][^'"]*)\1/m;

const copyModules = (destination, ...entries) => {
  const copied = [];
  const visit = file => {
    if (copied.includes(file)) return;
    copied.push(file);
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const external = source.match(bare);
    if (external) throw Error(`${file} imports ${external[2]}; a browser fixture can load application modules only`);
    const rewritten = source.replace(relative, (match, head, quote, id) => {
      const target = path.posix.join(path.posix.dirname(file), id);
      visit(path.posix.extname(target) ? target : target + '.js');
      return head + quote + (path.posix.extname(id) ? id : id + '.js') + quote;
    });
    const output = path.join(destination, file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, rewritten);
  };
  entries.forEach(visit);
  return copied;
};

// The fields a queued request carries from its document (see approvalIdentity).
// A native suite that exercises the queue alone uses fixed ones.
const documentFields = () => ({ activation: crypto.randomUUID(), requestToken: crypto.randomUUID(),
  navigationTab: 'initial', navigationFrame: 'initial' });

module.exports = { copyModules, documentFields };
