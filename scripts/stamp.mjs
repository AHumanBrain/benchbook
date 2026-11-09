// Stamps index.html so browsers fetch changed files straight away instead of reusing a cached copy for up to 10 minutes.
//
//     node scripts/stamp.mjs          rewrite index.html and build.json
//     node scripts/stamp.mjs --check  exit 1 if they are out of date (a test runs this)
//
// Run it after changing anything in src/, data/ or protocols/. Each module's URL gets ?v=<hash of its contents> through an
// import map, and build.json holds one id for the whole app, which the page compares with its own to offer a reload.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = p => readFileSync(new URL(p, root));
const hash = buf => createHash('sha1').update(buf).digest('hex').slice(0, 8);
const fileHash = p => hash(read(p));
const START = '<!-- stamp:start -->';
const END = '<!-- stamp:end -->';

export function compute() {
  const src = readdirSync(new URL('src/', root)).filter(f => /\.(js|css)$/.test(f)).sort();
  const js = src.filter(f => f.endsWith('.js'));
  const protocols = readdirSync(new URL('protocols/', root)).filter(f => f.endsWith('.json')).sort();
  const parts = [...src.map(f => `src/${f}:${fileHash(`src/${f}`)}`), ...protocols.map(f => `protocols/${f}:${fileHash(`protocols/${f}`)}`), `data/seed.json:${fileHash('data/seed.json')}`];
  const build = hash(parts.join('\n'));
  const imports = Object.fromEntries(js.map(f => [`./src/${f}`, `./src/${f}?v=${fileHash(`src/${f}`)}`]));
  const block = `${START}
<script type="importmap">${JSON.stringify({ imports })}</script>
<script>window.BUILD = "${build}";</script>
<link rel="stylesheet" href="src/style.css?v=${fileHash('src/style.css')}">
<script type="module" src="src/app.js?v=${fileHash('src/app.js')}"></script>
${END}`;
  const html = read('index.html').toString();
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < 0) throw new Error('index.html has no stamp markers');
  return { html: html.slice(0, a) + block + html.slice(b + END.length), build: JSON.stringify({ build }) + '\n' };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  const { html, build } = compute();
  if (process.argv.includes('--check')) {
    const stale = html !== read('index.html').toString() || build !== read('build.json').toString();
    console.log(stale ? 'stamp is out of date: run node scripts/stamp.mjs' : 'stamp is current');
    process.exit(stale ? 1 : 0);
  }
  writeFileSync(new URL('index.html', root), html);
  writeFileSync(new URL('build.json', root), build);
  console.log(`stamped build ${JSON.parse(build).build}`);
}
