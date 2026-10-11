'use strict';
// Build do EasyPrint (sem dependências):
//   node build.js         -> dist/easyprint-agent.js (agente em 1 arquivo) + SDK (UMD, ESM, .d.ts)
//   node build.js --exe   -> + dist/EasyPrint.exe (Node SEA; usa npx postject)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const pkg = require('./package.json');
const SRC = path.join(ROOT, 'agent', 'src');
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

// ---------- 0. skill de IA (.zip) + EASYPRINT_AI.md autossuficiente ----------
function zip(entries) { // { 'caminho/arquivo': Buffer } -> Buffer .zip (deflate), sem dependências
  const zlib = require('zlib');
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8'); const comp = zlib.deflateRawSync(data); const crc = zlib.crc32(data) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, nameBuf, comp); centrals.push(c, nameBuf); offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const SKILL = path.join(ROOT, 'skill', 'easyprint');
const read = (...p) => fs.readFileSync(path.join(...p));
const skillFiles = {
  'easyprint/SKILL.md': read(SKILL, 'SKILL.md'),
  'easyprint/reference/api.md': read(SKILL, 'reference', 'api.md'),
  'easyprint/reference/frameworks.md': read(SKILL, 'reference', 'frameworks.md'),
  'easyprint/reference/troubleshooting.md': read(SKILL, 'reference', 'troubleshooting.md'),
  'easyprint/reference/erp.md': read(SKILL, 'reference', 'erp.md'),
  'easyprint/assets/easyprint.js': read(ROOT, 'sdk', 'easyprint.js'),
  'easyprint/assets/easyprint.d.ts': read(ROOT, 'sdk', 'easyprint.d.ts'),
  'easyprint/assets/easyprint-cloud.js': read(ROOT, 'cloud', 'easyprint-cloud.js'),
};
const skillMd = skillFiles['easyprint/SKILL.md'].toString('utf8').replace(/^---[\s\S]*?---\s*/, '');
const aiMd = [
  '<!-- EASYPRINT_AI.md — gerado por build.js a partir de skill/easyprint. Entregue este arquivo a qualquer IA. -->',
  skillMd.replace(/`assets\/easyprint\.js`/g, '`easyprint.js` (código completo no Anexo A)').replace(/`assets\/easyprint\.d\.ts`/g, '`easyprint.d.ts` (Anexo B)')
    .replace(/`reference\/(api|frameworks|troubleshooting|erp)\.md`/g, (m, n) => `a seção "${{ api: 'Referência da API', frameworks: 'Modelos por framework', troubleshooting: 'Status e erros', erp: 'ERP e e-commerce' }[n]}" abaixo`),
  '\n---\n', skillFiles['easyprint/reference/api.md'].toString('utf8').replace(/^# .*/, '# Referência da API'),
  '\n---\n', skillFiles['easyprint/reference/frameworks.md'].toString('utf8'),
  '\n---\n', skillFiles['easyprint/reference/troubleshooting.md'].toString('utf8').replace(/^# .*/, '# Status e erros'),
  '\n---\n', skillFiles['easyprint/reference/erp.md'].toString('utf8').replace(/^# .*/, '# ERP e e-commerce'),
  '\n---\n# Anexo A — easyprint.js (crie este arquivo exatamente com este conteúdo)\n\n```js\n' + skillFiles['easyprint/assets/easyprint.js'].toString('utf8') + '\n```\n',
  '\n# Anexo B — easyprint.d.ts\n\n```ts\n' + skillFiles['easyprint/assets/easyprint.d.ts'].toString('utf8') + '\n```\n',
  '\n# Anexo C — easyprint-cloud.js (SDK de servidor, só para impressão pela nuvem)\n\n```js\n' + skillFiles['easyprint/assets/easyprint-cloud.js'].toString('utf8') + '\n```\n',
].join('\n');
const DL = path.join(ROOT, 'agent', 'assets', 'docs');
fs.mkdirSync(DL, { recursive: true });
fs.writeFileSync(path.join(DL, 'EASYPRINT_AI.md'), aiMd);
fs.writeFileSync(path.join(DL, 'easyprint-skill.zip'), zip(skillFiles));
fs.writeFileSync(path.join(ROOT, 'EASYPRINT_AI.md'), aiMd);
fs.copyFileSync(path.join(DL, 'EASYPRINT_AI.md'), path.join(DIST, 'EASYPRINT_AI.md'));
fs.copyFileSync(path.join(DL, 'easyprint-skill.zip'), path.join(DIST, 'easyprint-skill.zip'));
console.log(`✔ EASYPRINT_AI.md (${(aiMd.length / 1024).toFixed(0)} KB) e easyprint-skill.zip`);

// ---------- 1. empacota os módulos CommonJS do agente ----------
const modules = {};
function collect(file) {
  const id = path.relative(SRC, file).replace(/\\/g, '/');
  if (modules[id]) return;
  const code = fs.readFileSync(file, 'utf8');
  modules[id] = code;
  for (const m of code.matchAll(/require\(['"](\.{1,2}\/[^'"]+)['"]\)/g)) {
    let dep = path.resolve(path.dirname(file), m[1]);
    if (fs.existsSync(dep + '.js')) dep += '.js';
    else if (fs.existsSync(path.join(dep, 'index.js'))) dep = path.join(dep, 'index.js');
    collect(dep);
  }
}
collect(path.join(SRC, 'main.js'));

// ---------- 2. embute os assets (painel, scripts, SDK) ----------
const assets = {};
function addDir(dir, prefix) {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) addDir(full, prefix + f + '/');
    else assets[prefix + f] = fs.readFileSync(full).toString('base64');
  }
}
addDir(path.join(ROOT, 'agent', 'assets'), '');
assets['sdk/easyprint.js'] = fs.readFileSync(path.join(ROOT, 'sdk', 'easyprint.js')).toString('base64');

const bundle = `'use strict';
// EasyPrint agent — gerado por build.js. Não edite.
globalThis.__EASYPRINT_ASSETS__ = ${JSON.stringify(assets)};
const __modules = {
${Object.entries(modules).map(([id, code]) => `${JSON.stringify(id)}: function (module, exports, require, __filename, __dirname) {\n${code}\n}`).join(',\n')}
};
const __cache = {};
const __nativeRequire = require;
function __resolve(from, req) {
  const parts = from.split('/'); parts.pop();
  for (const seg of req.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  let id = parts.join('/');
  if (__modules[id + '.js']) return id + '.js';
  if (__modules[id + '/index.js']) return id + '/index.js';
  return id;
}
function __load(id) {
  if (__cache[id]) return __cache[id].exports;
  const module = { exports: {} }; __cache[id] = module;
  const localRequire = (r) => (r.startsWith('.') ? __load(__resolve(id, r)) : __nativeRequire(r));
  __modules[id](module, module.exports, localRequire, id, '.');
  return module.exports;
}
__load('main.js');
`;
fs.writeFileSync(path.join(DIST, 'easyprint-agent.js'), bundle);
console.log(`✔ dist/easyprint-agent.js (${Object.keys(modules).length} módulos, ${Object.keys(assets).length} assets, ${(bundle.length / 1024).toFixed(0)} KB)`);

// ---------- 3. SDK: UMD + ESM + tipos ----------
const sdk = fs.readFileSync(path.join(ROOT, 'sdk', 'easyprint.js'), 'utf8');
fs.copyFileSync(path.join(ROOT, 'sdk', 'easyprint.js'), path.join(DIST, 'easyprint.js'));
fs.copyFileSync(path.join(ROOT, 'sdk', 'easyprint.d.ts'), path.join(DIST, 'easyprint.d.ts'));
const esm = sdk.replace(/\(function \(root, factory\) \{[\s\S]*?\}\)\(typeof self[^,]+, function \(\) \{/, 'const EasyPrint = (function () {')
  .replace(/\}\);\s*$/, '})();\nexport default EasyPrint;\nexport const { connect, receipt, image, widget, messages, VERSION } = EasyPrint;\n');
if (!esm.includes('export default')) throw new Error('Falha ao gerar o SDK ESM');
fs.writeFileSync(path.join(DIST, 'easyprint.mjs'), esm);
console.log('✔ dist/easyprint.js (UMD), dist/easyprint.mjs (ESM), dist/easyprint.d.ts');

// ---------- 3b. site do GitHub Pages (pasta docs/): landing + documentação ----------
if (process.argv.includes('--site')) {
  const SITE = path.join(ROOT, 'docs');
  const wrap = (body, icon) => '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    + `<link rel="icon" href="${icon}"><meta name="theme-color" content="#12803f">`
    + '<meta property="og:title" content="EasyPrint"><meta property="og:description" content="Impressão direta do navegador para térmicas, etiquetas e A4. Open source.">'
    + '</head><body>' + body + '</body></html>';
  fs.rmSync(SITE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'index.html'), wrap(fs.readFileSync(path.join(ROOT, 'site', 'landing.html'), 'utf8'), 'icon.png'));
  fs.writeFileSync(path.join(SITE, 'docs', 'index.html'), wrap(fs.readFileSync(path.join(ROOT, 'agent', 'assets', 'docs', 'index.html'), 'utf8'), '../icon.png'));
  fs.copyFileSync(path.join(ROOT, 'agent', 'assets', 'icon.png'), path.join(SITE, 'icon.png'));
  fs.copyFileSync(path.join(DL, 'EASYPRINT_AI.md'), path.join(SITE, 'docs', 'EASYPRINT_AI.md'));
  fs.copyFileSync(path.join(DL, 'easyprint-skill.zip'), path.join(SITE, 'docs', 'easyprint-skill.zip'));
  fs.writeFileSync(path.join(SITE, '.nojekyll'), '');
  console.log('✔ docs/ (GitHub Pages: landing + documentação)');
}

// ---------- 4. executáveis únicos (Node SEA) ----------
//   --exe    -> binário da plataforma atual (no Windows: EasyPrint.exe com ícone e sem console)
//   --linux  -> também gera dist/easyprint-linux-x64 (baixa o Node oficial para Linux)
const TOOLS = path.join(DIST, '.tools');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function seaBlob() {
  const blob = path.join(DIST, 'sea-prep.blob');
  if (!fs.existsSync(blob)) {
    fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify({
      main: path.join(DIST, 'easyprint-agent.js'), output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false,
    }));
    run(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')]);
    fs.rmSync(path.join(DIST, 'sea-config.json'));
  }
  return blob;
}

function inject(target, extra = []) {
  run(npx, ['--yes', 'postject@1.0.0-alpha.6', target, 'NODE_SEA_BLOB', seaBlob(), '--sentinel-fuse', SENTINEL, ...extra], { shell: process.platform === 'win32' });
}

// Troca o subsistema do PE de "console" (3) para "janela" (2): o .exe abre sem a janela preta
function setGuiSubsystem(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    const hdr = Buffer.alloc(4); fs.readSync(fd, hdr, 0, 4, 0x3c);
    const pe = hdr.readUInt32LE(0);
    const sig = Buffer.alloc(4); fs.readSync(fd, sig, 0, 4, pe);
    if (sig.toString('latin1') !== 'PE\0\0') throw new Error('PE inválido');
    const sub = Buffer.alloc(2); sub.writeUInt16LE(2);
    fs.writeSync(fd, sub, 0, 2, pe + 24 + 68);
  } finally { fs.closeSync(fd); }
}

async function rcedit(file) {
  const mod = path.join(TOOLS, 'node_modules', 'rcedit');
  if (!fs.existsSync(mod)) run(npm, ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', TOOLS, 'rcedit@3.1.0'], { shell: true });
  const edit = require(mod);
  await edit(file, {
    icon: path.join(ROOT, 'agent', 'assets', 'icon.ico'),
    'file-version': `${pkg.version}.0`, 'product-version': pkg.version,
    'version-string': {
      ProductName: 'EasyPrint', FileDescription: 'EasyPrint — impressão direta do navegador', CompanyName: 'EasyPrint (open source)',
      LegalCopyright: 'Licença MIT', OriginalFilename: 'EasyPrint.exe', InternalName: 'EasyPrint',
    },
    'requested-execution-level': 'asInvoker',
  });
}

async function buildWindows() {
  const exe = path.join(DIST, 'EasyPrint.exe');
  fs.copyFileSync(process.execPath, exe);
  await rcedit(exe);          // ícone + versão ANTES de injetar (o rcedit reescreve os recursos)
  inject(exe);
  setGuiSubsystem(exe);
  console.log(`✔ dist/EasyPrint.exe (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB, ícone, sem console)`);
}

async function buildLinux() {
  const ver = process.version; // o blob precisa da MESMA versão do Node
  const name = `node-${ver}-linux-x64`;
  const tarball = path.join(TOOLS, `${name}.tar.xz`);
  fs.mkdirSync(TOOLS, { recursive: true });
  if (!fs.existsSync(tarball)) {
    console.log(`… baixando Node ${ver} para Linux`);
    const res = await fetch(`https://nodejs.org/dist/${ver}/${name}.tar.xz`);
    if (!res.ok) throw new Error('Falha ao baixar o Node para Linux: HTTP ' + res.status);
    fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  }
  const nodeBin = path.join(TOOLS, name, 'bin', 'node');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';
  if (!fs.existsSync(nodeBin)) run(tar, ['-xJf', tarball, '-C', TOOLS, `${name}/bin/node`]);
  const out = path.join(DIST, 'easyprint-linux-x64');
  if (process.platform === 'linux') {
    fs.copyFileSync(nodeBin, out);
    inject(out);
  } else {
    // Fora do Linux, a injeção roda num container (o postject não injeta ELF a partir do Windows)
    fs.writeFileSync(path.join(DIST, 'sea-linux.json'), JSON.stringify({
      main: '/dist/easyprint-agent.js', output: '/dist/sea-linux.blob', disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false,
    }));
    const node = `/dist/.tools/${name}/bin/node`;
    const script = [
      `${node} --experimental-sea-config /dist/sea-linux.json`,
      `cp ${node} /dist/easyprint-linux-x64`,
      `npx --yes postject@1.0.0-alpha.6 /dist/easyprint-linux-x64 NODE_SEA_BLOB /dist/sea-linux.blob --sentinel-fuse ${SENTINEL}`,
      'chmod 755 /dist/easyprint-linux-x64',
      'rm -f /dist/sea-linux.blob /dist/sea-linux.json',
    ].join(' && ');
    run('docker', ['run', '--rm', '-v', `${DIST}:/dist`, 'node:24-bookworm', 'bash', '-c', script], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  }
  console.log(`✔ dist/easyprint-linux-x64 (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
}

(async () => {
  if (process.argv.includes('--exe')) {
    if (process.platform === 'win32') await buildWindows();
    else { const out = path.join(DIST, 'easyprint'); fs.copyFileSync(process.execPath, out); inject(out, process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []); }
  }
  if (process.argv.includes('--linux')) await buildLinux();
  fs.rmSync(path.join(DIST, 'sea-prep.blob'), { force: true });
})().catch((e) => { console.error('✖', e.message); process.exit(1); });
