'use strict';
// Integração com o sistema operacional: abrir janelas, início automático, auto-instalação e bandeja.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extract, asset } = require('./assets');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const isPackaged = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();

function detached(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

function openUrl(url) {
  if (isWin) return detached('rundll32', ['url.dll,FileProtocolHandler', url]);
  if (isMac) return detached('open', [url]);
  return detached('xdg-open', [url]);
}

function which(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, name);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* próximo */ }
  }
  return null;
}

// Navegador que suporta "--app" (janela sem barra de endereço = cara de aplicativo)
let appBrowser;
function findAppBrowser() {
  if (appBrowser !== undefined) return appBrowser;
  const candidates = [];
  if (isWin) {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (isMac) {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
      const f = which(n); if (f) candidates.push(f);
    }
  }
  appBrowser = candidates.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
  return appBrowser;
}

// Abre o painel numa janela própria (Edge/Chrome em modo app); sem eles, usa o navegador padrão
function openApp(url, { width = 1180, height = 820 } = {}) {
  const browser = findAppBrowser();
  if (browser && detached(browser, [`--app=${url}`, `--window-size=${width},${height}`])) return true;
  return openUrl(url);
}

// Comando que inicia o EasyPrint (executável empacotado ou node + script em desenvolvimento)
function launchCommand() {
  if (isPackaged) return { file: process.execPath, args: [] };
  return { file: process.execPath, args: [path.resolve(process.argv[1])] };
}

// ---------------- início automático ----------------
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LINUX_AUTOSTART = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'easyprint.desktop');
const MAC_AGENT = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.easyprint.agent.plist');

function regExec(args) {
  return new Promise((resolve) => execFile('reg', args, { windowsHide: true }, (err, stdout) => resolve(err ? null : stdout)));
}

function desktopEntry({ exec, autostart }) {
  const icon = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'easyprint.png');
  return [
    '[Desktop Entry]', 'Type=Application', 'Name=EasyPrint', 'GenericName=Impressão direta do navegador',
    'Comment=Imprima cupons, etiquetas e PDFs direto do sistema da sua loja', `Exec=${exec}`,
    `Icon=${fs.existsSync(icon) ? icon : 'printer'}`, 'Terminal=false', 'Categories=Office;Utility;', 'StartupNotify=false',
    autostart ? 'X-GNOME-Autostart-enabled=true' : '', '',
  ].filter((l) => l !== null).join('\n');
}

async function getAutostart() {
  if (isWin) { const out = await regExec(['query', RUN_KEY, '/v', 'EasyPrint']); return !!out && out.includes('EasyPrint'); }
  if (isLinux) return fs.existsSync(LINUX_AUTOSTART);
  if (isMac) return fs.existsSync(MAC_AGENT);
  return false;
}

async function setAutostart(enabled) {
  const { file, args } = launchCommand();
  if (isWin) {
    if (!enabled) { await regExec(['delete', RUN_KEY, '/v', 'EasyPrint', '/f']); return false; }
    const value = [file, ...args].map((a) => `"${a}"`).join(' ') + ' --background';
    await regExec(['add', RUN_KEY, '/v', 'EasyPrint', '/t', 'REG_SZ', '/d', value, '/f']);
    return true;
  }
  if (isLinux) {
    if (!enabled) { fs.rmSync(LINUX_AUTOSTART, { force: true }); return false; }
    fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
    const exec = [file, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') + ' --background';
    fs.writeFileSync(LINUX_AUTOSTART, desktopEntry({ exec, autostart: true }));
    return true;
  }
  if (isMac) {
    if (!enabled) { fs.rmSync(MAC_AGENT, { force: true }); return false; }
    fs.mkdirSync(path.dirname(MAC_AGENT), { recursive: true });
    const argsXml = [file, ...args, '--background'].map((a) => `<string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('');
    fs.writeFileSync(MAC_AGENT, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>io.easyprint.agent</string><key>ProgramArguments</key><array>${argsXml}</array><key>RunAtLoad</key><true/></dict></plist>\n`);
    return true;
  }
  return false;
}

// ---------------- auto-instalação (sem administrador) ----------------
// Windows: %LOCALAPPDATA%\Programs\EasyPrint + atalho no menu Iniciar
// Linux:   ~/.local/bin/easyprint + atalho no menu de aplicativos + ícone
function installSelfIfNeeded(log) {
  if (!isPackaged || process.argv.includes('--no-install')) return false;
  if (isWin) return installWindows(log);
  if (isLinux) return installLinux(log);
  return false;
}

function relaunch(target) {
  spawn(target, process.argv.slice(2), { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => process.exit(0), 300);
}

function installWindows(log) {
  const target = path.join(process.env.LOCALAPPDATA, 'Programs', 'EasyPrint', 'EasyPrint.exe');
  if (path.resolve(process.execPath).toLowerCase() === target.toLowerCase()) return false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(process.execPath, target);
    const lnk = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'EasyPrint.lnk');
    const desk = path.join(os.homedir(), 'Desktop', 'EasyPrint.lnk');
    const q = (s) => s.replace(/'/g, "''");
    const ps = [lnk, desk].map((l) => `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${q(l)}');$s.TargetPath='${q(target)}';$s.IconLocation='${q(target)},0';$s.Description='EasyPrint - impressão direta do navegador';$s.Save()`).join(';');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true }, () => relaunch(target));
    return true;
  } catch (e) {
    log('Não foi possível instalar em', target, '-', e.message, '(seguindo a partir do local atual)');
    return false;
  }
}

function linuxShortcut(target) {
  const home = os.homedir();
  const iconDir = path.join(home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps');
  fs.mkdirSync(iconDir, { recursive: true });
  const png = asset('icon.png'); if (png) fs.writeFileSync(path.join(iconDir, 'easyprint.png'), png);
  const appDir = path.join(home, '.local', 'share', 'applications');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'easyprint.desktop'), desktopEntry({ exec: target, autostart: false }));
}

function installLinux(log) {
  const target = path.join(os.homedir(), '.local', 'bin', 'easyprint');
  if (path.resolve(process.execPath) === target) {
    try { linuxShortcut(target); } catch { /* atalho é opcional */ }
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(process.execPath, target);
    fs.chmodSync(target, 0o755);
    linuxShortcut(target);
    log('EasyPrint instalado em', target);
    relaunch(target);
    return true;
  } catch (e) {
    log('Não foi possível instalar em', target, '-', e.message, '(seguindo a partir do local atual)');
    return false;
  }
}

// ---------------- bandeja (Windows) ----------------
function startTray({ port, adminToken, runtimeDir, log }) {
  if (!isWin || process.argv.includes('--no-tray')) return null;
  const script = extract('win-tray.ps1', runtimeDir);
  const icon = extract('icon.ico', runtimeDir);
  const browser = findAppBrowser() || '';
  const proc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-STA', '-File', script,
    '-Port', String(port), '-Admin', adminToken, '-ParentPid', String(process.pid), '-IconPath', icon, '-Browser', browser,
  ], { windowsHide: true, stdio: 'ignore' });
  proc.on('exit', (code) => log('Ícone da bandeja encerrado', code));
  return proc;
}

module.exports = { findAppBrowser, openUrl, openApp, getAutostart, setAutostart, installSelfIfNeeded, startTray, isPackaged, isWin, isLinux, isMac, which };
