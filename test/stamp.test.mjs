import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compute } from '../scripts/stamp.mjs';

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('index.html and build.json are stamped for the current files (run: node scripts/stamp.mjs)', () => {
  const { html, build } = compute();
  assert.equal(read('index.html'), html, 'index.html is stale: run node scripts/stamp.mjs');
  assert.equal(read('build.json'), build, 'build.json is stale: run node scripts/stamp.mjs');
});

test('every module is in the import map with a version, and the page knows its build id', () => {
  const html = read('index.html');
  const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)[1]).imports;
  const modules = readdirSync(new URL('../src/', import.meta.url)).filter(f => f.endsWith('.js'));
  assert.deepEqual(Object.keys(map).sort(), modules.map(f => `./src/${f}`).sort());
  for (const v of Object.values(map)) assert.match(v, /\?v=[0-9a-f]{8}$/);
  const id = /window\.BUILD = "([0-9a-f]{8})"/.exec(html)[1];
  assert.equal(JSON.parse(read('build.json')).build, id);
  assert.match(html, /src="src\/app\.js\?v=[0-9a-f]{8}"/);
  assert.match(html, /href="src\/style\.css\?v=[0-9a-f]{8}"/);
});

test('the stamp is deterministic', () => {
  assert.deepEqual(compute(), compute());
});
