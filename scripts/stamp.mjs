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
const sha256 = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const START = '<!-- stamp:start -->';
const END = '<!-- stamp:end -->';

export function compute() {
  const src = readdirSync(new URL('src/', root)).filter(f => /\.(js|css)$/.test(f)).sort();
  const js = src.filter(f => f.endsWith('.js'));
  const protocols = readdirSync(new URL('protocols/', root)).filter(f => f.endsWith('.json')).sort();
  const parts = [...src.map(f => `src/${f}:${fileHash(`src/${f}`)}`), ...protocols.map(f => `protocols/${f}:${fileHash(`protocols/${f}`)}`), `data/seed.json:${fileHash('data/seed.json')}`];
  const build = hash(parts.join('\n'));
  const imports = Object.fromEntries(js.map(f => [`./src/${f}`, `./src/${f}?v=${fileHash(`src/${f}`)}`]));
  // Inline scripts are allowed by hash and nothing else: markup that gets into the page cannot run script.
  const inline = [
    `try{var t=localStorage.getItem('benchbook.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`,
    JSON.stringify({ imports }),
    `window.BUILD = "${build}";`,
  ];
  const csp = ["default-src 'self'", `script-src 'self' ${inline.map(sha256).join(' ')}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join('; ');
  const block = `${START}
<meta http-equiv="Content-Security-Policy" content="${csp}">
<script>${inline[0]}</script>
<script type="importmap">${inline[1]}</script>
<script>${inline[2]}</script>
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
