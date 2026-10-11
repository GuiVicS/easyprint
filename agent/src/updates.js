'use strict';
// Aviso de nova versão: consulta a última release no GitHub uma vez por dia.
// Só faz um GET público (sem enviar dados do computador). Pode ser desligado no painel.
const { VERSION } = require('./config');

const RELEASES_API = 'https://api.github.com/repos/GuiVicS/easyprint/releases/latest';
const RELEASES_PAGE = 'https://github.com/GuiVicS/easyprint/releases/latest';

function newer(a, b) { // a > b ?
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

class UpdateChecker {
  constructor({ config, log, onUpdate }) {
    this.config = config;
    this.log = log;
    this.onUpdate = onUpdate || (() => {});
    this.state = { current: VERSION, latest: null, available: false, url: RELEASES_PAGE, checkedAt: null };
    this.timer = null;
  }

  enabled() { return this.config.get('checkUpdates') !== false; }

  start() {
    const run = () => this.check().catch((e) => this.log('Verificação de atualização falhou:', e.message));
    this.timer = setTimeout(function tick() { run(); this.timer = setTimeout(tick.bind(this), 24 * 3600 * 1000); }.bind(this), 30000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { clearTimeout(this.timer); }

  async check() {
    if (!this.enabled()) return this.state;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(RELEASES_API, { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json', 'User-Agent': `EasyPrint/${VERSION}` } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const tag = String(data.tag_name || '').replace(/^v/, '');
      const wasAvailable = this.state.available;
      this.state = { current: VERSION, latest: tag || null, available: !!tag && newer(tag, VERSION), url: String(data.html_url || RELEASES_PAGE), checkedAt: new Date().toISOString() };
      if (this.state.available && !wasAvailable) this.onUpdate(this.state);
      return this.state;
    } finally { clearTimeout(t); }
  }
}

module.exports = { UpdateChecker, newer };
