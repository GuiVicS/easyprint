'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.0.0';
const DEFAULT_PORTS = [17777, 17778, 17779];

function homeDir() {
  if (process.env.EASYPRINT_HOME) return process.env.EASYPRINT_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'EasyPrint');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'EasyPrint');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'easyprint');
}

const DEFAULTS = {
  version: VERSION,
  setupDone: false,
  defaultPrinter: null,     // nome da impressora padrão do EasyPrint (null = padrão do sistema)
  profiles: {},             // nome da impressora -> perfil (modo, papel, codepage...)
  sites: [],                // { origin, appName, approvedAt, lastUsed }
  denied: [],               // { origin, at }
  tokens: [],               // { id, name, hash, createdAt, lastUsed }
  routes: {},               // finalidade -> nome da impressora (ex.: { etiqueta: 'ZDesigner ZD220' })
  knownRoutes: {},          // finalidades anunciadas pelos sistemas: { etiqueta: { label, source, firstSeen } }
  cloud: [],                // conexões de impressão pela nuvem (veja cloud.js)
  autostart: false,
  notifications: true,
};

class Config {
  constructor() {
    this.dir = homeDir();
    this.file = path.join(this.dir, 'config.json');
    fs.mkdirSync(this.dir, { recursive: true });
    this.data = { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
    } catch { /* primeira execução */ }
  }

  get(key) { return this.data[key]; }

  set(key, value) { this.data[key] = value; this.save(); }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 }); // só o usuário lê
    fs.renameSync(tmp, this.file);
  }

  path(...p) { return path.join(this.dir, ...p); }
}

module.exports = { Config, VERSION, DEFAULT_PORTS, homeDir };
