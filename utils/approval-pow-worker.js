'use strict';
// Build a static worker from the exact installed/pinned SDK constants. Parsing
// the exported literals avoids executing dependency code during generation.
const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const sdkRoot = path.dirname(require.resolve('znn-ts-sdk/package.json'));
const literal = (file, name) => {
  const ast = babel.parseSync(fs.readFileSync(path.join(sdkRoot, file), 'utf8'), { configFile: false, babelrc: false, sourceType: 'module' });
  const declarations = ast.program.body.flatMap(node => node.type === 'ExportNamedDeclaration' ? node.declaration?.declarations || [] : []);
  const value = declarations.find(node => node.id?.name === name)?.init;
  if (value?.type !== 'TemplateLiteral' || value.expressions.length || value.quasis.length !== 1 || typeof value.quasis[0].value.cooked !== 'string') throw Error('Unexpected pinned SDK PoW source: ' + name);
  return value.quasis[0].value.cooked;
};
module.exports = () => {
  const wasm = literal('lib/src/pow/base/base64.ts', 'base64Wasm');
  const runtime = literal('lib/src/pow/base/znn-pow-string.ts', 'stringPow');
  const license = fs.readFileSync(path.join(sdkRoot, 'LICENSE'), 'utf8').replace(/\*\//g, '* /');
  return '/*! PoW runtime from pinned znn-ts-sdk 0.1.3; generated at build time.\n' + license + '*/\n' +
    'var wasmPath=' + JSON.stringify(wasm) + ';\n' +
    'var Module={onRuntimeInitialized:function(){self.postMessage({ready:true});}};\n' + runtime + '\n' +
    `let used=false;self.onmessage=function(event){if(used)return;used=true;try{const input=event.data;if(!input||!/^[0-9a-f]{64}$/i.test(input.hash)||!/^\\d{1,20}$/.test(input.difficulty))throw Error('Invalid PoW input');const compute=Module.cwrap('generatePoW','string',['string','string']);self.postMessage({nonce:compute(input.hash,input.difficulty)});}catch(error){self.postMessage({error:'Proof of work failed'});}};\n`;
};
