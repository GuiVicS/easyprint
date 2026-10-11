/* EasyPrint — painel local (sem dependências). */
(function () {
  'use strict';

  const ADMIN = document.querySelector('meta[name="easyprint-admin"]').content;
  const VERSION = document.querySelector('meta[name="easyprint-version"]').content;
  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');

  // ---------- utilidades ----------
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v; // usado só com texto estático do próprio painel
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  async function api(path, body) {
    const res = await fetch('/api/admin/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-EasyPrint-Admin': ADMIN, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false, error: { message: 'Resposta inválida do EasyPrint.' } }));
    if (!data.ok) { const e = new Error(data.error.message); e.code = data.error.code; e.hint = data.error.hint; throw e; }
    return data.result;
  }

  function toast(msg, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
    document.getElementById('toast-root').append(t);
    setTimeout(() => t.remove(), err ? 6000 : 3500);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => toast('Copiado!'), () => toast('Não foi possível copiar.', true));
  }

  const KIND = {
    thermal: { ico: '🧾', label: 'Térmica de cupom' },
    label: { ico: '🏷️', label: 'Etiquetas' },
    office: { ico: '🖨️', label: 'Impressora comum' },
    system: { ico: '📄', label: 'Impressora do sistema (PDF/XPS/Fax)' },
    virtual: { ico: '🧪', label: 'Simulador (sem papel)' },
  };
  const MODE = {
    escpos: { ico: '🧾', title: 'Cupom (impressora térmica)', desc: 'Pedidos, comandas e recibos em bobina de 58 ou 80 mm. Ex.: Epson TM-T20, Elgin i9, Bematech MP-4200.' },
    zpl: { ico: '🏷️', title: 'Etiquetas (Zebra/ZPL)', desc: 'Etiquetas adesivas e de envio. Ex.: Zebra ZD220, GC420, Elgin L42 Pro.' },
    office: { ico: '🖨️', title: 'Folha comum (A4/Carta)', desc: 'Impressoras jato de tinta ou laser de escritório.' },
    virtual: { ico: '🧪', title: 'Simulador', desc: 'Mostra a impressão na tela. Ótimo para testar sem gastar papel.' },
  };
  const CODEPAGES = [
    ['cp860', 'Português — CP860 (recomendado)'],
    ['cp850', 'Multilíngue — CP850 (algumas Bematech/Elgin)'],
    ['cp1252', 'Windows — CP1252'],
    ['ascii', 'Sem acentos (funciona em qualquer impressora)'],
  ];

  // ---------- estado ----------
  let state = null;
  let printers = null;

  async function refresh(fresh) {
    [state, printers] = await Promise.all([api('state'), api('printers' + (fresh ? '?fresh=1' : ''))]);
  }

  // ---------- eventos ao vivo ----------
  function connectEvents() {
    const es = new EventSource('/api/admin/events?admin=' + encodeURIComponent(ADMIN));
    const pill = document.getElementById('status-pill');
    es.addEventListener('hello', () => { pill.className = 'pill pill-ok'; pill.textContent = '● Funcionando'; });
    es.addEventListener('pairing', (e) => { const req = JSON.parse(e.data); showApprovalModal(req); });
    es.addEventListener('resolved', (e) => {
      const r = JSON.parse(e.data);
      const open = document.querySelector(`[data-request="${r.id}"]`);
      if (open) closeModal();
      if (route().name === 'home' || route().name === 'sites') render();
    });
    es.addEventListener('cloud', (e) => {
      const ev = JSON.parse(e.data);
      if (ev.code) toast(`Trabalho recusado (${ev.connection}): ${ev.message}`, true);
      if (route().name === 'nuvem') render();
    });
    es.addEventListener('ratelimit', (e) => { const r = JSON.parse(e.data); toast(`Impressões demais de ${r.source}: bloqueadas por segurança.`, true); });
    es.addEventListener('update', () => { if (route().name === 'home') render(); });
    es.addEventListener('job', (e) => {
      const job = JSON.parse(e.data);
      if (route().name === 'historico') render();
      if (job.status === 'failed') toast(`Falha ao imprimir em ${job.printer}: ${job.error}`, true);
    });
    es.onerror = () => { pill.className = 'pill pill-danger'; pill.textContent = '● Desconectado'; };
  }

  // ---------- roteamento ----------
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    return { name: parts[0] || 'home', arg: parts[1] };
  }

  const views = { home: viewHome, assistente: viewWizard, aprovar: viewApprove, impressoras: viewPrinters, sites: viewSites, nuvem: viewCloud, historico: viewHistory, integracao: viewDev, ajuda: viewHelp };

  const LABEL_PRESETS = [[100, 150, 'Envio (Correios, Mercado Livre, Shopee)'], [100, 100, 'Quadrada'], [100, 50, 'Produto grande'], [60, 40, 'Produto / gôndola'], [50, 30, 'Pequena'], [40, 25, 'Joia / preço']];
  const PAPER_SIZES = [['auto', 'Automático (padrão da impressora)'], ['A4', 'A4'], ['A5', 'A5'], ['Letter', 'Carta'], ['Legal', 'Ofício']];

  // Campos de tamanho conforme o tipo (etiqueta: mm + dpi; comum: papel)
  function sizeFields(prof, onChange) {
    if (prof.mode === 'zpl') {
      const current = `${prof.labelWidth || 100}x${prof.labelHeight || ''}`;
      return h('div', { class: 'stack' },
        h('h3', null, 'Tamanho da etiqueta'),
        h('p', { class: 'muted small' }, 'Meça a etiqueta (largura × altura, em milímetros). A de envio dos marketplaces é 100 × 150 mm.'),
        h('div', { class: 'grid grid-3' }, LABEL_PRESETS.map(([w, hgt, d]) => h('button', {
          class: 'choice' + (current === `${w}x${hgt}` ? ' selected' : ''), type: 'button',
          onclick: () => { prof.labelWidth = w; prof.labelHeight = hgt; onChange(); },
        }, h('span', null, h('span', { class: 'title' }, `${w} × ${hgt} mm`), h('span', { class: 'desc' }, d))))),
        h('div', { class: 'grid grid-3' },
          h('div', null, h('label', { class: 'field' }, 'Largura (mm)'), h('input', { type: 'number', min: 20, max: 220, value: prof.labelWidth || 100, onchange: (e) => { prof.labelWidth = Number(e.target.value); } })),
          h('div', null, h('label', { class: 'field' }, 'Altura (mm)'), h('input', { type: 'number', min: 10, max: 400, value: prof.labelHeight || '', placeholder: 'contínua', onchange: (e) => { prof.labelHeight = e.target.value ? Number(e.target.value) : null; } })),
          h('div', null, h('label', { class: 'field' }, 'Resolução'), h('select', { onchange: (e) => { prof.dpi = Number(e.target.value); } },
            [[203, '203 dpi (mais comum)'], [300, '300 dpi']].map(([v, t]) => h('option', { value: v, selected: Number(prof.dpi || 203) === v }, t))))));
    }
    if (prof.mode === 'office') {
      return h('div', { class: 'stack' }, h('h3', null, 'Papel'),
        h('p', { class: 'muted small' }, 'Usado para PDF (DANFE, boletos, relatórios). "Automático" usa o papel configurado no Windows.'),
        h('select', { onchange: (e) => { prof.paperSize = e.target.value; } }, PAPER_SIZES.map(([v, t]) => h('option', { value: v, selected: (prof.paperSize || 'auto') === v }, t))));
    }
    return null;
  }

  async function render() {
    const r = route();
    document.querySelectorAll('#nav a').forEach((a) => {
      const target = a.getAttribute('href').replace(/^#\/?/, '') || 'home';
      a.classList.toggle('active', target === r.name);
    });
    try {
      if (!state || r.name !== 'assistente') await refresh();
      if (!state.setupDone && r.name === 'home') { location.hash = '#/assistente'; return; }
      const view = views[r.name] || viewHome;
      const el = await view(r.arg);
      if (el) app.replaceChildren(el);
    } catch (e) {
      app.replaceChildren(h('div', { class: 'callout callout-danger' }, h('strong', null, 'Não foi possível carregar o painel'), e.message));
    }
  }
  window.addEventListener('hashchange', () => { wizard = null; render(); });

  // ---------- componentes ----------
  function printerIcon(p) { return (KIND[p.kind] || KIND.office).ico; }

  function receiptPreview(lines, columns) {
    columns = columns || 48;
    const paper = h('div', { class: 'paper', style: `width: calc(${columns}ch + 24px)` });
    for (const l of lines || []) {
      if (l.kind === 'text') {
        const span = h('div', { class: 'l' + (l.bold ? ' b' : '') + (l.underline ? ' u' : ''), style: `text-align:${l.align};${l.size > 1 ? `font-size:${l.size}em;line-height:1.2` : ''}` }, h('span', { class: l.invert ? 'inv' : '' }, l.text || ' '));
        paper.append(span);
      } else if (l.kind === 'qr') paper.append(h('div', { class: 'qr' }, 'QR', h('br'), h('small', null, l.value.slice(0, 40))));
      else if (l.kind === 'barcode') paper.append(h('div', { class: 'bar', title: l.value }), h('div', { class: 'l', style: 'text-align:center' }, l.value));
      else if (l.kind === 'image') paper.append(h('img', { src: l.src, alt: 'imagem' }));
      else if (l.kind === 'feed') for (let i = 0; i < Math.min(l.lines, 4); i++) paper.append(h('div', { class: 'l' }, ' '));
      else if (l.kind === 'cut') paper.append(h('div', { class: 'cut' }));
      else if (l.kind === 'drawer') paper.append(h('div', { class: 'l', style: 'text-align:center;color:#888' }, '[abre gaveta]'));
    }
    return paper;
  }

  function closeModal() { modalRoot.replaceChildren(); }
  function modal(content) {
    const back = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === back) closeModal(); } }, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, content));
    modalRoot.replaceChildren(back);
  }

  function approvalCard(req, onDone) {
    const isHttps = req.origin.startsWith('https://');
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.origin);
    const decide = async (approve) => {
      try {
        await api('pairing', { id: req.id, approve });
        toast(approve ? 'Site autorizado! Pode voltar para ele.' : 'Site bloqueado.');
        onDone && onDone(approve);
      } catch (e) { toast(e.message, true); }
    };
    return h('div', { class: 'approval', 'data-request': req.id },
      h('div', { class: 'hero-ico' }, '🖨️'),
      h('h2', null, 'Um site quer usar suas impressoras'),
      req.appName ? h('p', { class: 'muted' }, 'Ele se identificou como ', h('strong', null, req.appName)) : null,
      h('div', { class: 'origin' }, isHttps ? '🔒 ' : '', req.origin),
      !isHttps && !isLocal ? h('div', { class: 'callout callout-warn small' }, h('strong', null, 'Atenção: site sem HTTPS'), 'A conexão com este site não é criptografada. Só permita se você confia nele.') : null,
      h('ul', { class: 'facts small' },
        h('li', null, '✅ Poderá imprimir e ver a lista de impressoras'),
        h('li', null, '🚫 Não terá acesso aos seus arquivos nem a outros programas'),
        h('li', null, '↩️ Você pode remover a permissão quando quiser em "Sites e apps"')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => decide(true) }, 'Permitir'),
        h('button', { class: 'btn btn-lg', onclick: () => decide(false) }, 'Bloquear')),
      h('p', { class: 'muted small', style: 'margin-top:14px' }, 'Não reconhece este endereço? Clique em Bloquear.'));
  }

  function showApprovalModal(req) {
    if (route().name === 'aprovar') { render(); return; }
    modal(approvalCard(req, closeModal));
  }

  // ---------- telas ----------
  async function viewApprove(id) {
    const req = state.pending.find((p) => p.id === id) || state.pending[0];
    if (!req) {
      return h('div', { class: 'wizard' }, h('div', { class: 'card approval' },
        h('div', { class: 'hero-ico' }, '👍'), h('h2', null, 'Nenhum pedido pendente'),
        h('p', { class: 'muted' }, 'Esse pedido já foi respondido. Você pode voltar ao site e continuar.'),
        h('a', { class: 'btn', href: '#/' }, 'Ir para o início')));
    }
    return h('div', { class: 'wizard' }, h('div', { class: 'card' }, approvalCard(req, (approved) => {
      app.replaceChildren(h('div', { class: 'wizard' }, h('div', { class: 'card approval' },
        h('div', { class: 'hero-ico' }, approved ? '🎉' : '🛑'),
        h('h2', null, approved ? 'Pronto! Site autorizado.' : 'Site bloqueado.'),
        h('p', { class: 'muted' }, approved ? 'Pode fechar esta aba e voltar para o site. A impressão já vai funcionar.' : 'Ele não poderá imprimir. Se foi engano, desbloqueie em "Sites e apps".'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => window.close() }, 'Fechar esta aba'), h('a', { class: 'btn', href: '#/' }, 'Ir para o painel')))));
    })));
  }

  async function viewHome() {
    const def = printers.find((p) => p.isDefault);
    const jobs = await api('jobs');
    const today = new Date().toDateString();
    const todayJobs = jobs.filter((j) => new Date(j.at).toDateString() === today);
    const failed = todayJobs.filter((j) => j.status === 'failed').length;

    const testBtn = h('button', { class: 'btn btn-primary', onclick: async () => {
      testBtn.disabled = true;
      try { await api('test-print', {}); toast('Página de teste enviada!'); } catch (e) { toast(e.message + (e.hint ? ' — ' + e.hint : ''), true); }
      testBtn.disabled = false;
    } }, 'Imprimir teste');

    return h('div', null,
      h('h1', null, 'Olá! 👋'),
      state.update && state.update.available ? h('div', { class: 'callout callout-ok', style: 'margin:12px 0' },
        h('strong', null, `Nova versão disponível: ${state.update.latest}`),
        'Ela traz correções e melhorias. Baixe e abra o novo EasyPrint; suas configurações são mantidas. ',
        h('a', { href: state.update.url, target: '_blank', rel: 'noopener' }, 'Baixar a nova versão →')) : null,
      h('p', { class: 'muted' }, 'O EasyPrint deixa os sites que você autorizou imprimirem direto na sua impressora, sem janelas de impressão.'),
      state.pending.length ? h('div', { class: 'callout callout-warn', style: 'margin:16px 0' },
        h('strong', null, `${state.pending.length} site(s) aguardando sua permissão`),
        state.pending.map((p) => h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { class: 'mono' }, p.origin), h('a', { class: 'btn btn-sm btn-primary', href: '#/aprovar/' + p.id }, 'Responder')))) : null,
      h('div', { class: 'grid grid-2', style: 'margin-top:18px' },
        h('div', { class: 'card' },
          h('div', { class: 'muted small' }, 'IMPRESSORA PADRÃO'),
          def ? h('div', null,
            h('div', { class: 'row', style: 'margin:8px 0 4px' }, h('span', { style: 'font-size:28px' }, printerIcon(def)), h('h2', { style: 'margin:0' }, def.name)),
            h('p', { class: 'muted small' }, (KIND[def.kind] || {}).label, def.profile.mode === 'escpos' ? ` · papel ${def.profile.paperWidth} mm` : ''),
            h('div', { class: 'row' }, testBtn, h('a', { class: 'btn', href: '#/impressoras' }, 'Trocar ou ajustar')))
            : h('div', null, h('p', null, 'Nenhuma impressora escolhida ainda.'), h('a', { class: 'btn btn-primary', href: '#/assistente' }, 'Abrir assistente'))),
        h('div', { class: 'card' },
          h('div', { class: 'muted small' }, 'HOJE'),
          h('div', { class: 'row', style: 'margin-top:8px; gap: 28px' },
            h('div', null, h('div', { class: 'stat' }, todayJobs.length), h('div', { class: 'muted small' }, 'impressões')),
            h('div', null, h('div', { class: 'stat', style: failed ? 'color:var(--danger)' : '' }, failed), h('div', { class: 'muted small' }, 'falhas')),
            h('div', null, h('div', { class: 'stat' }, state.sites.length), h('div', { class: 'muted small' }, 'sites autorizados'))),
          h('p', { style: 'margin-top:14px' }, h('a', { href: '#/historico' }, 'Ver histórico →')))),
      h('div', { class: 'card', style: 'margin-top:16px' },
        h('h3', null, 'Iniciar junto com o computador'),
        h('p', { class: 'muted small' }, 'Recomendado: assim a impressão funciona sempre, sem precisar lembrar de abrir o EasyPrint.'),
        autostartSwitch(),
        h('div', { style: 'margin-top:12px' }, permSwitch('Avisar quando houver nova versão', state.checkUpdates !== false, (v) => api('settings', { checkUpdates: v }), 'Consulta a página de versões no GitHub uma vez por dia'))),
      h('p', { class: 'muted small', style: 'margin-top:24px' }, `EasyPrint ${VERSION} · porta ${state.port} · `, h('a', { href: '#/assistente' }, 'refazer configuração')));
  }

  function permSwitch(label, checked, save, hint) {
    const input = h('input', { type: 'checkbox', checked, onchange: async () => {
      try { await save(input.checked); toast(input.checked ? `"${label}" liberado.` : `"${label}" bloqueado.`); }
      catch (e) { toast(e.message, true); input.checked = !input.checked; }
    } });
    return h('label', { class: 'switch small', title: hint || '' }, input, label);
  }

  function autostartSwitch() {
    if (state.platform !== 'win32') return h('p', { class: 'muted small' }, 'Disponível no Windows. No macOS/Linux, adicione o EasyPrint aos itens de inicialização do sistema.');
    const input = h('input', { type: 'checkbox', checked: state.autostart, onchange: async () => {
      try { await api('autostart', { enabled: input.checked }); toast(input.checked ? 'O EasyPrint vai abrir junto com o Windows.' : 'Início automático desativado.'); }
      catch (e) { toast(e.message, true); input.checked = !input.checked; }
    } });
    return h('label', { class: 'switch' }, input, 'Abrir o EasyPrint quando o Windows iniciar');
  }

  // ---------- assistente ----------
  let wizard = null;

  async function viewWizard() {
    if (!wizard) wizard = { step: 0, printer: null, profile: null, attempts: { codepage: 0 } };
    await refresh();
    return renderWizard();
  }

  function rerenderWizard() { app.replaceChildren(renderWizard()); window.scrollTo(0, 0); }

  function renderWizard() {
    const STEPS = ['Boas-vindas', 'Impressora', 'Tipo', 'Teste', 'Pronto'];
    const s = wizard.step;
    const bar = h('div', { class: 'steps' }, STEPS.map((_, i) => h('div', { class: 's ' + (i < s ? 'done' : i === s ? 'now' : '') })));
    const label = h('div', { class: 'step-label' }, `Passo ${s + 1} de ${STEPS.length} · ${STEPS[s]}`);
    const body = [stepWelcome, stepPrinter, stepType, stepTest, stepDone][s]();
    return h('div', { class: 'wizard' }, bar, h('div', { class: 'card' }, label, body));
  }

  const next = () => { wizard.step++; rerenderWizard(); };
  const back = () => { wizard.step--; rerenderWizard(); };

  function stepWelcome() {
    return h('div', null,
      h('div', { class: 'hero-ico', style: 'margin-top:12px' }, '🖨️✨'),
      h('h1', null, 'Bem-vindo ao EasyPrint'),
      h('p', { class: 'muted' }, 'Vamos deixar sua impressora pronta em 4 passos rápidos (cerca de 2 minutos).'),
      h('ul', { class: 'bullets' },
        h('li', null, h('span', null, '⚡'), h('span', null, h('strong', null, 'Impressão direta: '), 'o sistema da sua loja imprime pedidos e etiquetas sem abrir a janela de impressão.')),
        h('li', null, h('span', null, '🔒'), h('span', null, h('strong', null, 'Você no controle: '), 'só imprime quem você autorizar, com um clique.')),
        h('li', null, h('span', null, '🇧🇷'), h('span', null, h('strong', null, 'Acentos certinhos: '), 'ç, ã, é e companhia saem corretos em impressoras térmicas.'))),
      h('div', { class: 'wizard-actions' }, h('button', { class: 'btn btn-primary btn-lg', onclick: next }, 'Começar →')));
  }

  function stepPrinter() {
    const main = printers.filter((p) => p.kind !== 'system' && p.kind !== 'virtual');
    const other = printers.filter((p) => p.kind === 'system');
    const sim = printers.find((p) => p.kind === 'virtual');
    if (!wizard.printer) wizard.printer = (main.find((p) => p.isDefault) || main[0] || sim).name;

    const choice = (p) => h('button', {
      class: 'choice' + (wizard.printer === p.name ? ' selected' : ''),
      onclick: () => { wizard.printer = p.name; wizard.profile = null; rerenderWizard(); },
    },
      h('span', { class: 'ico' }, printerIcon(p)),
      h('span', null,
        h('span', { class: 'title' }, p.name, p.isSystemDefault ? h('span', { class: 'pill pill-neutral', style: 'margin-left:8px' }, 'padrão do Windows') : null),
        h('span', { class: 'desc' }, 'Detectamos: ', (KIND[p.kind] || KIND.office).label, p.kind === 'thermal' ? ` (${p.profile.paperWidth} mm)` : '', p.online ? '' : ' · ⚠️ parece desligada')));

    const searching = h('button', { class: 'btn btn-sm', onclick: async () => { searching.disabled = true; searching.textContent = 'Procurando…'; await refresh(true); rerenderWizard(); } }, '🔄 Procurar novamente');

    return h('div', null,
      h('h1', null, 'Qual impressora você vai usar?'),
      h('p', { class: 'muted' }, 'Estas são as impressoras instaladas neste computador. Escolha a que vai imprimir os pedidos.'),
      main.length ? h('div', { class: 'stack' }, main.map(choice)) : h('div', { class: 'callout callout-warn' }, h('strong', null, 'Nenhuma impressora encontrada'), 'Siga as dicas abaixo ou use o Simulador por enquanto.'),
      h('div', { class: 'stack', style: 'margin-top:12px' }, choice(sim)),
      other.length ? h('details', { style: 'margin-top:12px' }, h('summary', { class: 'muted small' }, `Outras (${other.length}) — PDF, XPS, Fax`), h('div', { class: 'stack', style: 'margin-top:8px' }, other.map(choice))) : null,
      h('div', { class: 'callout', style: 'margin-top:18px' },
        h('strong', null, 'Não encontrou sua impressora?'),
        h('ol', null,
          h('li', null, 'Confira se ela está ligada e com o cabo USB (ou rede) conectado.'),
          h('li', null, 'Instale o driver do fabricante (Epson, Elgin, Bematech…). Sem driver, o Windows não a enxerga.'),
          h('li', null, 'Para térmicas sem driver, você pode instalar o driver "Generic / Text Only" do Windows.')),
        h('div', { style: 'margin-top:10px' }, searching)),
      h('div', { class: 'wizard-actions' },
        h('button', { class: 'btn', onclick: back }, '← Voltar'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary btn-lg', onclick: next, disabled: !wizard.printer }, 'Continuar →')));
  }

  function currentPrinter() { return printers.find((p) => p.name === wizard.printer); }

  function stepType() {
    const p = currentPrinter();
    if (!wizard.profile) wizard.profile = { ...p.profile };
    const prof = wizard.profile;
    const detected = p.profile.mode;
    const modes = p.kind === 'virtual' ? ['virtual'] : ['escpos', 'zpl', 'office'];

    const modeChoice = (m) => h('button', { class: 'choice' + (prof.mode === m ? ' selected' : ''), onclick: () => {
      prof.mode = m;
      if (m === 'escpos') { prof.paperWidth = prof.paperWidth || 80; prof.codepage = ['cp860', 'cp850', 'cp1252', 'ascii'].includes(prof.codepage) ? prof.codepage : 'cp860'; prof.autoCut = true; }
      if (m === 'office') { prof.autoCut = false; prof.paperSize = prof.paperSize || 'auto'; }
      if (m === 'zpl') { prof.labelWidth = prof.labelWidth || 100; prof.dpi = prof.dpi || 203; prof.autoCut = false; }
      prof.columns = undefined;
      rerenderWizard();
    } },
      h('span', { class: 'ico' }, MODE[m].ico),
      h('span', null, h('span', { class: 'title' }, MODE[m].title, m === detected && !p.profile.configured ? h('span', { class: 'pill pill-ok', style: 'margin-left:8px' }, 'detectado') : null), h('span', { class: 'desc' }, MODE[m].desc)));

    const paper = prof.mode === 'escpos' ? h('div', { style: 'margin-top:18px' },
      h('h3', null, 'Largura do papel'),
      h('p', { class: 'muted small' }, 'Meça a bobina: a mais comum em delivery e caixas é a de 80 mm. A de 58 mm é a das maquininhas e impressoras compactas.'),
      h('div', { class: 'grid grid-2' }, [80, 58].map((w) => h('button', { class: 'choice' + (prof.paperWidth === w ? ' selected' : ''), onclick: () => { prof.paperWidth = w; prof.columns = undefined; rerenderWizard(); } },
        h('span', { class: 'ico' }, w === 80 ? '📏' : '📐'),
        h('span', null, h('span', { class: 'title' }, `${w} mm`), h('span', { class: 'desc' }, w === 80 ? '48 caracteres por linha' : '32 caracteres por linha')))))) : null;

    const advanced = prof.mode === 'escpos' ? h('details', { style: 'margin-top:16px' },
      h('summary', { class: 'muted small' }, 'Opções avançadas'),
      h('div', { class: 'grid grid-2', style: 'margin-top:10px' },
        h('div', null, h('label', { class: 'field' }, 'Tabela de acentos'),
          h('select', { onchange: (e) => { prof.codepage = e.target.value; } }, CODEPAGES.map(([v, t]) => h('option', { value: v, selected: prof.codepage === v }, t)))),
        h('div', null, h('label', { class: 'field' }, 'Corte automático'),
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: prof.autoCut !== false, onchange: (e) => { prof.autoCut = e.target.checked; } }), 'Cortar o papel ao final')))) : null;

    const sizes = sizeFields(prof, rerenderWizard);
    return h('div', null,
      h('h1', null, 'Que tipo de impressão é?'),
      h('p', { class: 'muted' }, 'Já deixamos marcada a opção que detectamos para ', h('strong', null, p.name), '. Se estiver certo, é só continuar.'),
      h('div', { class: 'stack' }, modes.map(modeChoice)),
      paper, sizes ? h('div', { style: 'margin-top:18px' }, sizes) : null, advanced,
      h('div', { class: 'wizard-actions' },
        h('button', { class: 'btn', onclick: back }, '← Voltar'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary btn-lg', onclick: async () => {
          try {
            await api('profile', { printer: p.name, profile: prof });
            await api('default', { printer: p.name });
            await refresh();
            wizard.testResult = null;
            next();
          } catch (e) { toast(e.message, true); }
        } }, 'Salvar e testar →')));
  }

  function stepTest() {
    const p = currentPrinter();
    const r = wizard.testResult;
    const isVirtual = p.kind === 'virtual';
    const btn = h('button', { class: 'btn btn-primary btn-lg', onclick: () => doTest() }, r ? '🔁 Imprimir de novo' : '🖨️ Imprimir página de teste');

    async function doTest(variant) {
      btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), ' Imprimindo…');
      try {
        const res = await api('test-print', { printer: p.name, variant });
        const jobs = await api('jobs');
        wizard.testResult = { ok: true, job: jobs.find((j) => j.id === res.jobId) };
      } catch (e) {
        wizard.testResult = { ok: false, error: e };
      }
      rerenderWizard();
    }

    async function fixCodepage() {
      const order = ['cp860', 'cp850', 'cp1252', 'ascii'];
      const prof = { ...p.profile };
      const nextCp = order[(order.indexOf(prof.codepage) + 1) % order.length];
      prof.codepage = nextCp;
      await api('profile', { printer: p.name, profile: prof });
      await refresh();
      toast('Trocamos a tabela de acentos para: ' + CODEPAGES.find((c) => c[0] === nextCp)[1]);
      doTest('accents');
    }

    async function switchPaper() {
      const prof = { ...p.profile, paperWidth: p.profile.paperWidth === 80 ? 58 : 80, columns: undefined };
      await api('profile', { printer: p.name, profile: prof });
      await refresh();
      toast(`Ajustamos para papel de ${prof.paperWidth} mm.`);
      doTest();
    }

    let result = null;
    if (r && !r.ok) {
      result = h('div', { class: 'callout callout-danger', style: 'margin-top:18px' },
        h('strong', null, 'Não conseguimos imprimir'), h('p', null, r.error.message), r.error.hint ? h('p', { class: 'small' }, '💡 ', r.error.hint) : null,
        troubleshooting());
    } else if (r && r.ok) {
      result = h('div', { style: 'margin-top:18px' },
        isVirtual && r.job ? h('div', { style: 'margin-bottom:16px' }, h('p', { class: 'muted small' }, 'Pré-visualização do Simulador:'), receiptPreview(r.job.preview, r.job.columns)) : null,
        h('h3', null, isVirtual ? 'A pré-visualização ficou boa?' : 'O papel saiu certinho?'),
        h('div', { class: 'stack' },
          h('button', { class: 'choice', onclick: next }, h('span', { class: 'ico' }, '✅'), h('span', null, h('span', { class: 'title' }, 'Sim, saiu perfeito!'), h('span', { class: 'desc' }, 'Vamos para o último passo.'))),
          p.profile.mode === 'escpos' ? h('button', { class: 'choice', onclick: fixCodepage }, h('span', { class: 'ico' }, '🔤'), h('span', null, h('span', { class: 'title' }, 'Os acentos saíram estranhos (ex.: "a��o")'), h('span', { class: 'desc' }, 'Vamos testar outra tabela de acentos automaticamente.'))) : null,
          p.profile.mode === 'escpos' ? h('button', { class: 'choice', onclick: switchPaper }, h('span', { class: 'ico' }, '📏'), h('span', null, h('span', { class: 'title' }, 'O texto saiu cortado ou muito estreito'), h('span', { class: 'desc' }, `Vamos trocar para papel de ${p.profile.paperWidth === 80 ? 58 : 80} mm.`))) : null,
          !isVirtual ? h('details', { class: 'choice', style: 'display:block' }, h('summary', { style: 'cursor:pointer;font-weight:700' }, '😕 Não saiu nada'), troubleshooting()) : null));
    }

    return h('div', null,
      h('h1', null, 'Hora do teste!'),
      h('p', { class: 'muted' }, isVirtual ? 'O Simulador mostra aqui na tela como a impressão ficaria.' : `Vamos imprimir um cupom de exemplo em "${p.name}". Confira se tem papel.`),
      h('div', { class: 'row' }, btn),
      result,
      h('div', { class: 'wizard-actions' },
        h('button', { class: 'btn', onclick: back }, '← Voltar'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn-link', onclick: next }, 'Pular teste')));
  }

  function troubleshooting() {
    return h('div', { class: 'small', style: 'margin-top:8px' },
      h('ol', null,
        h('li', null, 'A impressora está ligada, com a tampa fechada e com papel?'),
        h('li', null, 'O cabo USB (ou de rede) está bem conectado? Tente outra porta USB.'),
        h('li', null, 'No Windows, abra "Impressoras e scanners" e veja se há documentos travados na fila — cancele-os.'),
        h('li', null, 'Imprima uma página de teste pelo próprio Windows. Se também não sair, o problema é no driver/cabo.'),
        h('li', null, 'Se a térmica imprimir símbolos estranhos, volte um passo e confirme o tipo "Cupom".')));
  }

  function stepDone() {
    const p = currentPrinter();
    return h('div', null,
      h('div', { class: 'hero-ico', style: 'margin-top:12px' }, '🎉'),
      h('h1', null, 'Tudo pronto!'),
      h('p', { class: 'muted' }, 'Sua impressora padrão é ', h('strong', null, p ? p.name : '—'), '.'),
      h('div', { class: 'callout callout-ok', style: 'margin:16px 0' },
        h('strong', null, 'Como funciona daqui pra frente'),
        h('ol', null,
          h('li', null, 'Abra o sistema da sua loja normalmente no navegador.'),
          h('li', null, 'Na primeira vez, o EasyPrint vai perguntar se aquele site pode imprimir. Clique em ', h('strong', null, 'Permitir'), '.'),
          h('li', null, 'O navegador (Chrome/Edge) também pode perguntar sobre "acessar apps neste dispositivo". Clique em ', h('strong', null, 'Permitir'), ' também.'))),
      h('div', { class: 'card', style: 'box-shadow:none' }, autostartSwitch()),
      h('div', { class: 'wizard-actions' },
        h('button', { class: 'btn', onclick: back }, '← Voltar'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary btn-lg', onclick: async () => {
          await api('settings', { setupDone: true });
          if (state.platform === 'win32' && !state.autostart) { try { await api('autostart', { enabled: true }); } catch { /* opcional */ } }
          wizard = null; location.hash = '#/';
        } }, 'Concluir')));
  }

  // ---------- impressoras ----------
  let editing = null;
  async function viewPrinters() {
    const list = h('div');
    for (const p of printers) {
      const row = h('div', { class: 'printer' },
        h('div', { class: 'ico' }, printerIcon(p)),
        h('div', { class: 'meta' },
          h('div', { class: 'name' }, p.name),
          h('div', { class: 'muted small' }, (KIND[p.kind] || KIND.office).label, p.profile.mode === 'escpos' ? ` · ${p.profile.paperWidth} mm · ${p.profile.codepage}` : '', p.driver ? ` · driver: ${p.driver}` : '')),
        p.isDefault ? h('span', { class: 'pill pill-ok' }, '★ Padrão') : h('button', { class: 'btn btn-sm', onclick: async () => { await api('default', { printer: p.name }); toast('Impressora padrão alterada.'); render(); } }, 'Tornar padrão'),
        p.online ? null : h('span', { class: 'pill pill-warn' }, 'offline'),
        h('button', { class: 'btn btn-sm', onclick: async () => { try { await api('test-print', { printer: p.name }); toast('Teste enviado para ' + p.name); } catch (e) { toast(e.message, true); } } }, 'Testar'),
        h('button', { class: 'btn btn-sm', onclick: () => { editing = editing === p.name ? null : p.name; render(); } }, editing === p.name ? 'Fechar' : 'Ajustar'));
      list.append(row);
      if (editing === p.name) list.append(profileEditor(p));
    }
    return h('div', null,
      h('div', { class: 'section-title' }, h('h1', { style: 'margin:0' }, 'Impressoras'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: async () => { await refresh(true); render(); toast('Lista atualizada.'); } }, '🔄 Atualizar')),
      h('p', { class: 'muted' }, 'O EasyPrint detecta o tipo de cada impressora automaticamente. Use "Ajustar" se algo não sair como esperado.'),
      list,
      routesSection());
  }

  function profileEditor(p, prof) {
    prof = prof || { ...p.profile };
    const field = (label, control) => h('div', null, h('label', { class: 'field' }, label), control);
    const rerender = () => { const fresh = profileEditor(p, prof); el.replaceWith(fresh); };
    const el = h('div', { class: 'editor' },
      h('div', { class: 'grid grid-3' },
        field('Tipo', h('select', { onchange: (e) => { prof.mode = e.target.value; rerender(); } },
          Object.entries(MODE).filter(([m]) => p.kind === 'virtual' ? m === 'virtual' : m !== 'virtual').map(([m, d]) => h('option', { value: m, selected: prof.mode === m }, d.title)))),
        field('Papel (térmica)', h('select', { onchange: (e) => { prof.paperWidth = Number(e.target.value); prof.columns = undefined; } },
          [80, 58].map((w) => h('option', { value: w, selected: prof.paperWidth === w }, `${w} mm`)))),
        field('Acentos (térmica)', h('select', { onchange: (e) => { prof.codepage = e.target.value; } }, CODEPAGES.map(([v, t]) => h('option', { value: v, selected: prof.codepage === v }, t)))),
        field('Caracteres por linha', h('input', { type: 'number', min: 16, max: 120, value: p.profile.columns, onchange: (e) => { prof.columns = Number(e.target.value); } })),
        field('Corte automático', h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: prof.autoCut !== false, onchange: (e) => { prof.autoCut = e.target.checked; } }), 'Cortar ao final'))),
      h('div', { style: 'margin-top:14px' }, sizeFields(prof, rerender)),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn btn-primary', onclick: async () => { delete prof.configured; await api('profile', { printer: p.name, profile: prof }); editing = null; toast('Configuração salva.'); render(); } }, 'Salvar'),
        h('button', { class: 'btn', onclick: async () => { await api('profile', { printer: p.name, profile: {} }); editing = null; toast('Voltou para a detecção automática.'); render(); } }, 'Restaurar automático')));
    return el;
  }

  // ---------- finalidades ----------
  function routesSection() {
    const known = state.knownRoutes || {};
    const routes = state.routes || {};
    const keys = [...new Set([...Object.keys(known), ...Object.keys(routes)])].sort();
    const options = printers.filter((p) => p.kind !== 'system' || p.isDefault);
    const input = h('input', { type: 'text', placeholder: 'ex.: cozinha', maxlength: 40 });
    return h('div', { class: 'card', style: 'margin-top:24px' },
      h('h2', null, 'Finalidades'),
      h('p', { class: 'muted small' }, 'Os sistemas dizem o que querem imprimir (pedido, etiqueta, nota fiscal…) e você escolhe em qual impressora sai cada coisa. Sem escolha, sai na impressora padrão.'),
      keys.length ? keys.map((k) => {
        const info = known[k] || { label: k };
        const missing = routes[k] && !printers.some((p) => p.name === routes[k]);
        return h('div', { class: 'list-item' },
          h('div', { class: 'meta' },
            h('strong', null, info.label), h('span', { class: 'muted small mono' }, '  ', k),
            h('div', { class: 'muted small' }, info.source && info.source !== 'manual' ? `Pedido por ${info.source}` : 'Criada manualmente',
              routes[k] ? '' : ' · ', routes[k] ? null : h('span', { style: 'color:var(--warn)' }, 'usando a impressora padrão'))),
          missing ? h('span', { class: 'pill pill-danger' }, 'impressora não encontrada') : null,
          h('select', { style: 'max-width:280px', onchange: async (e) => {
            try { await api('routes', { route: k, printer: e.target.value || null }); toast(`"${info.label}" → ${e.target.value || 'impressora padrão'}`); await refresh(); }
            catch (err) { toast(err.message, true); }
          } },
            h('option', { value: '' }, 'Impressora padrão'),
            options.map((p) => h('option', { value: p.name, selected: routes[k] === p.name }, p.name))));
      }) : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🗂️'), 'Nenhuma finalidade ainda. Elas aparecem quando um sistema se conecta, ou crie uma abaixo.'),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { style: 'flex:1;min-width:200px' }, input),
        h('button', { class: 'btn', onclick: async () => {
          try { await api('routes', { route: input.value.trim().toLowerCase(), printer: null }); toast('Finalidade criada. Escolha a impressora dela.'); render(); }
          catch (e) { toast(e.message + (e.hint ? ' — ' + e.hint : ''), true); }
        } }, 'Criar finalidade')));
  }

  // ---------- nuvem ----------
  async function viewCloud() {
    const conns = await api('cloud');
    const code = h('textarea', { rows: 3, placeholder: 'Cole aqui o código de conexão (começa com EPC1.)', style: 'width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:13px ui-monospace,Consolas,monospace' });
    const STATE = {
      online: ['pill-ok', '● Conectado'], connecting: ['pill-neutral', 'Conectando…'], offline: ['pill-warn', 'Sem internet / servidor fora'],
      unauthorized: ['pill-danger', 'Acesso revogado'], paused: ['pill-neutral', 'Pausado'],
    };
    const toggle = (c, key, label, hint) => {
      const input = h('input', { type: 'checkbox', checked: c[key], onchange: async () => {
        try { await api('cloud/update', { id: c.id, [key]: input.checked }); toast('Configuração salva.'); }
        catch (e) { toast(e.message, true); input.checked = !input.checked; }
      } });
      return h('label', { class: 'switch small', title: hint }, input, label);
    };
    return h('div', null,
      h('h1', null, 'Impressão pela nuvem'),
      h('p', { class: 'muted' }, 'Deixa o seu ERP ou loja virtual imprimir sozinho, mesmo sem nenhuma página aberta. Por exemplo: chegou um pedido de madrugada e a etiqueta já sai na impressora.'),
      h('div', { class: 'grid grid-3', style: 'margin:16px 0' },
        h('div', { class: 'callout' }, h('strong', null, '🔒 Assinado e cifrado'), 'Cada impressão é assinada pelo seu sistema e cifrada só para este computador. Ninguém no caminho lê os pedidos.'),
        h('div', { class: 'callout' }, h('strong', null, '🚪 Sem portas abertas'), 'O EasyPrint só faz conexões de saída, por HTTPS.'),
        h('div', { class: 'callout' }, h('strong', null, '💵 Gaveta protegida'), 'Abrir gaveta pela nuvem vem bloqueado. Libere só se precisar.')),
      h('div', { class: 'card' },
        h('h3', null, 'Conectar a um sistema'),
        h('ol', { class: 'small', style: 'margin:0 0 12px;padding-left:20px' },
          h('li', null, 'No seu ERP, procure "Impressão automática" ou "EasyPrint" e gere um código de conexão para este computador.'),
          h('li', null, 'Cole o código aqui e clique em Conectar. O código só funciona uma vez.'),
          h('li', null, 'Confira se a "impressão digital da criptografia" que aparece aqui é igual à mostrada no seu sistema.')),
        code,
        h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'btn btn-primary', onclick: async () => {
          try { const c = await api('cloud/add', { code: code.value }); toast(`Conectado a ${c.name}!`); render(); }
          catch (e) { toast(e.message + (e.hint ? ' — ' + e.hint : ''), true); }
        } }, 'Conectar'))),
      conns.length ? h('div', { class: 'card' }, h('h3', null, 'Conexões'),
        conns.map((c) => {
          const [cls, label] = STATE[c.state] || STATE.connecting;
          return h('div', { class: 'list-item', style: 'align-items:flex-start' },
            h('div', { style: 'font-size:22px' }, '☁️'),
            h('div', { class: 'meta' },
              h('div', { class: 'row', style: 'gap:8px' }, h('strong', null, c.name), h('span', { class: 'pill ' + cls }, label), c.dev ? h('span', { class: 'pill pill-warn' }, 'modo desenvolvimento (sem HTTPS)') : null),
              h('div', { class: 'muted small' }, c.host, ' · dispositivo ', h('code', null, c.deviceId)),
              h('div', { class: 'muted small' }, 'Assinatura do sistema: ', h('code', null, c.fingerprint)),
              c.encryptionFingerprint ? h('div', { class: 'muted small' }, '🔐 Impressão digital da criptografia: ', h('code', null, c.encryptionFingerprint)) : null,
              h('div', { class: 'muted small' }, `${c.printed} impressos · ${c.rejected} recusados`, c.lastContact ? ` · último contato ${fmtDate(c.lastContact)}` : ''),
              c.lastError ? h('div', { class: 'small', style: 'color:var(--danger);margin-top:4px' }, c.lastError) : null,
              h('div', { class: 'row', style: 'margin-top:10px;gap:18px' },
                toggle(c, 'enabled', 'Ativa'),
                toggle(c, 'allowPdf', 'PDF', 'Notas fiscais, etiquetas em PDF, boletos'),
                toggle(c, 'allowRaw', 'Comandos RAW', 'ZPL/ESC/POS enviados diretamente (ex.: etiqueta do Mercado Livre)'),
                toggle(c, 'allowDrawer', 'Abrir gaveta', 'Permite que o sistema abra a gaveta de dinheiro remotamente'))),
            h('button', { class: 'btn btn-sm btn-danger', onclick: () => modal(h('div', null,
              h('h2', null, `Desconectar de ${c.name}?`),
              h('p', { class: 'muted' }, 'O sistema não conseguirá mais imprimir neste computador pela nuvem. Para voltar, será preciso um novo código.'),
              h('div', { class: 'row' },
                h('button', { class: 'btn btn-primary', onclick: async () => { await api('cloud/remove', { id: c.id }); closeModal(); toast('Desconectado.'); render(); } }, 'Desconectar'),
                h('button', { class: 'btn', onclick: closeModal }, 'Cancelar')))) }, 'Desconectar'));
        })) : null);
  }

  // ---------- sites ----------
  async function viewSites() {
    const input = h('input', { type: 'text', placeholder: 'https://minhaloja.com.br' });
    const tokenName = h('input', { type: 'text', placeholder: 'Ex.: Servidor da loja' });
    return h('div', null,
      h('h1', null, 'Sites e apps autorizados'),
      h('p', { class: 'muted' }, 'Só os endereços desta lista conseguem imprimir. Novos sites pedem permissão automaticamente. Abrir a gaveta de dinheiro vem bloqueado: libere só para o sistema do caixa.'),
      state.pending.length ? h('div', { class: 'callout callout-warn', style: 'margin-bottom:16px' }, h('strong', null, 'Aguardando sua resposta'),
        state.pending.map((p) => h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { class: 'mono' }, p.origin), h('a', { class: 'btn btn-sm btn-primary', href: '#/aprovar/' + p.id }, 'Responder')))) : null,
      h('div', { class: 'card' },
        h('h3', null, '✅ Autorizados'),
        state.sites.length ? state.sites.map((s) => h('div', { class: 'list-item' },
          h('div', { class: 'meta' }, h('div', { class: 'mono' }, s.origin), h('div', { class: 'muted small' }, s.appName ? s.appName + ' · ' : '', 'autorizado em ', fmtDate(s.approvedAt), ' · último uso ', fmtDate(s.lastUsed))),
          permSwitch('Abrir gaveta', !!s.allowDrawer, (v) => api('sites/update', { origin: s.origin, allowDrawer: v }), 'Permite que este site abra a gaveta de dinheiro'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: async () => { await api('sites/remove', { origin: s.origin }); toast('Permissão removida.'); render(); } }, 'Remover')))
          : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🌐'), 'Nenhum site autorizado ainda. Quando um site pedir, ele aparece aqui.'),
        h('div', { class: 'row', style: 'margin-top:14px' }, h('div', { style: 'flex:1;min-width:220px' }, input),
          h('button', { class: 'btn', onclick: async () => { try { await api('sites/add', { origin: input.value.trim() }); toast('Site adicionado.'); render(); } catch (e) { toast(e.message + (e.hint ? ' — ' + e.hint : ''), true); } } }, 'Adicionar manualmente'))),
      state.denied.length ? h('div', { class: 'card' }, h('h3', null, '🚫 Bloqueados'),
        state.denied.map((s) => h('div', { class: 'list-item' }, h('div', { class: 'meta' }, h('div', { class: 'mono' }, s.origin), h('div', { class: 'muted small' }, 'bloqueado em ', fmtDate(s.at))),
          h('button', { class: 'btn btn-sm', onclick: async () => { await api('sites/unblock', { origin: s.origin }); toast('Desbloqueado. Ao acessar de novo, o site vai pedir permissão.'); render(); } }, 'Desbloquear')))) : null,
      h('div', { class: 'card' },
        h('h3', null, '🔑 Apps locais (sem navegador)'),
        h('p', { class: 'muted small' }, 'Para sistemas que rodam no próprio computador (servidor local, app desktop, scripts). Eles usam um token em vez da permissão por site.'),
        state.tokens.map((t) => h('div', { class: 'list-item' }, h('div', { class: 'meta' }, h('strong', null, t.name), h('div', { class: 'muted small' }, 'criado em ', fmtDate(t.createdAt), ' · último uso ', fmtDate(t.lastUsed))),
          permSwitch('Abrir gaveta', !!t.allowDrawer, (v) => api('tokens/update', { id: t.id, allowDrawer: v }), 'Permite que este app abra a gaveta de dinheiro'),
          h('button', { class: 'btn btn-sm btn-danger', onclick: async () => { await api('tokens/revoke', { id: t.id }); toast('Token revogado.'); render(); } }, 'Revogar'))),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('div', { style: 'flex:1;min-width:220px' }, tokenName),
          h('button', { class: 'btn', onclick: async () => {
            const t = await api('tokens', { name: tokenName.value.trim() || 'App local' });
            modal(h('div', null, h('h2', null, 'Token criado'), h('p', { class: 'muted' }, 'Copie agora — por segurança ele não será mostrado de novo.'),
              h('div', { class: 'code' }, t.token), h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn btn-primary', onclick: () => copyText(t.token) }, 'Copiar'), h('button', { class: 'btn', onclick: () => { closeModal(); render(); } }, 'Fechar'))));
          } }, 'Criar token'))));
  }

  // ---------- histórico ----------
  async function viewHistory() {
    const jobs = await api('jobs');
    const STATUS = { done: ['pill-ok', 'Impresso'], failed: ['pill-danger', 'Falhou'], printing: ['pill-warn', 'Imprimindo'] };
    return h('div', null,
      h('h1', null, 'Histórico'),
      h('p', { class: 'muted' }, 'As últimas impressões desde que o EasyPrint foi aberto. Clique para ver como ficou.'),
      h('div', { class: 'card' }, jobs.length ? jobs.map((j) => h('div', { class: 'list-item', style: 'cursor:pointer', onclick: () => modal(h('div', null,
        h('h2', null, j.jobName), h('p', { class: 'muted small' }, j.printer, ' · ', fmtDate(j.at), j.origin ? ' · ' + j.origin : ''),
        j.error ? h('div', { class: 'callout callout-danger small', style: 'margin-bottom:12px' }, j.error) : null,
        receiptPreview(j.preview, j.columns),
        h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn', onclick: closeModal }, 'Fechar')))) },
        h('span', { style: 'font-size:20px' }, j.mode === 'virtual' ? '🧪' : j.mode === 'zpl' ? '🏷️' : j.mode === 'office' ? '🖨️' : '🧾'),
        h('div', { class: 'meta' }, h('div', null, h('strong', null, j.jobName), ' → ', j.printer), h('div', { class: 'muted small' }, fmtDate(j.at), ' · ', j.appName || j.origin || '—', j.copies > 1 ? ` · ${j.copies} cópias` : '')),
        h('span', { class: 'pill ' + (STATUS[j.status] || STATUS.printing)[0] }, (STATUS[j.status] || STATUS.printing)[1])))
        : h('div', { class: 'empty' }, h('span', { class: 'big' }, '🧾'), 'Nada impresso ainda.')));
  }

  // ---------- desenvolvedores ----------
  function codeBlock(code) {
    return h('div', { class: 'code' }, h('button', { class: 'btn btn-sm copy', onclick: () => copyText(code) }, 'Copiar'), code);
  }

  async function viewDev() {
    const snippet = `<script src="http://127.0.0.1:${state.port}/easyprint.js"></script>
<script>
  const printer = EasyPrint.connect({ appName: 'Minha Loja' });

  async function imprimirPedido() {
    await printer.print(
      EasyPrint.receipt()
        .title('PEDIDO #123')
        .line()
        .item(2, 'X-Burguer', 'R$ 59,80', 'sem cebola')
        .total('TOTAL', 'R$ 59,80')
        .qr('https://minhaloja.com/pedido/123')
        .cut()
    );
  }
</script>`;
    const prompt = `Integre a impressão direta com o EasyPrint neste projeto.
Siga exatamente as instruções do arquivo EASYPRINT_AI.md (cole o conteúdo dele aqui
ou coloque o arquivo na raiz do projeto). Detecte o framework, adicione o SDK,
crie o serviço de impressão, o indicador de status e a impressão do pedido/recibo.`;
    return h('div', null,
      h('h1', null, 'Para desenvolvedores'),
      h('p', { class: 'muted' }, 'Integre o EasyPrint em qualquer aplicação web em poucos minutos.'),
      h('div', { class: 'card' }, h('h3', null, '📚 Documentação e skill para IA'),
        h('p', { class: 'muted small' }, 'Guia completo com playground, referência da API, receitas por framework e os arquivos para sua IA integrar sozinha.'),
        h('div', { class: 'row' },
          h('a', { class: 'btn btn-primary', href: '/docs/', target: '_blank' }, 'Abrir documentação'),
          h('a', { class: 'btn', href: '/docs/easyprint-skill.zip', download: '' }, 'Baixar skill (.zip)'),
          h('a', { class: 'btn', href: '/docs/EASYPRINT_AI.md', download: '' }, 'Baixar EASYPRINT_AI.md'))),
      h('div', { class: 'card' }, h('h3', null, '1. Teste rápido (HTML puro)'),
        h('p', { class: 'muted small' }, 'Em produção, copie o arquivo easyprint.js para o seu projeto em vez de carregá-lo do agente.'), codeBlock(snippet)),
      h('div', { class: 'card' }, h('h3', null, '2. Integração com IA (Claude, ChatGPT, Cursor, Copilot…)'),
        h('p', { class: 'muted small' }, 'Envie o arquivo ', h('code', null, 'EASYPRINT_AI.md'), ' para a IA junto com este pedido. Ele contém tudo que ela precisa: API completa, exemplos para React, Vue, Angular, Next.js e HTML, tratamento de erros e checklist.'),
        codeBlock(prompt)),
      h('div', { class: 'card' }, h('h3', null, 'Conexão'),
        h('div', { class: 'small' },
          h('div', null, 'WebSocket: ', h('code', null, `ws://127.0.0.1:${state.port}/ws`)),
          h('div', null, 'Portas tentadas pelo SDK: ', h('code', null, '17777, 17778, 17779')),
          h('div', null, 'SDK: ', h('a', { href: '/easyprint.js', target: '_blank' }, '/easyprint.js')),
          h('div', null, 'Pasta de configuração: ', h('code', null, state.configDir)))));
  }

  // ---------- ajuda ----------
  async function viewHelp() {
    const faq = (q, ...a) => h('details', { class: 'faq' }, h('summary', null, q), h('div', null, ...a));
    return h('div', null,
      h('h1', null, 'Ajuda'),
      h('p', { class: 'muted' }, 'Problemas comuns e como resolver em poucos cliques.'),
      faq('O navegador perguntou se o site pode "acessar outros apps e serviços neste dispositivo"',
        h('p', null, 'É normal e seguro: é o navegador pedindo para o site conversar com o EasyPrint aqui no seu computador. Clique em ', h('strong', null, 'Permitir'), '.'),
        h('p', { class: 'muted small' }, 'Isso existe no Chrome e no Edge desde 2026 (proteção "Acesso à rede local").')),
      faq('Cliquei em "Bloquear" no navegador sem querer',
        h('ol', null, h('li', null, 'No site da loja, clique no ícone à esquerda do endereço (cadeado ou ajustes).'),
          h('li', null, 'Procure "Acesso à rede local" ou "Apps neste dispositivo" e mude para ', h('strong', null, 'Permitir'), '.'),
          h('li', null, 'Recarregue a página (F5).'))),
      faq('Bloqueei um site no EasyPrint sem querer', h('p', null, 'Vá em ', h('a', { href: '#/sites' }, 'Sites e apps'), ', encontre o site em "Bloqueados" e clique em Desbloquear.')),
      faq('Os acentos saem errados na impressora térmica',
        h('p', null, 'Abra ', h('a', { href: '#/impressoras' }, 'Impressoras'), ' → Ajustar → "Acentos" e teste CP860, depois CP850. Se nenhuma funcionar, use "Sem acentos".'),
        h('p', { class: 'muted small' }, 'Dica: o assistente faz isso automaticamente no passo de teste.')),
      faq('Minha impressora não aparece na lista',
        h('ol', null, h('li', null, 'Ligue a impressora e confira o cabo.'), h('li', null, 'Instale o driver do fabricante e veja se ela aparece em "Impressoras e scanners" do Windows.'), h('li', null, 'Clique em Atualizar na tela Impressoras.'))),
      faq('O site diz que o EasyPrint não está aberto',
        h('p', null, 'Procure o ícone verde do EasyPrint perto do relógio. Se não estiver lá, abra o EasyPrint pelo menu Iniciar. Para não acontecer de novo, ative "Abrir quando o Windows iniciar" na tela inicial.')),
      faq('Como desinstalar',
        h('p', null, 'Clique com o botão direito no ícone da bandeja → Sair. Depois apague a pasta ', h('code', null, '%LOCALAPPDATA%\\Programs\\EasyPrint'), ' e o atalho no menu Iniciar. Suas configurações ficam em ', h('code', null, state.configDir), '.')));
  }

  // ---------- início ----------
  connectEvents();
  render();
})();
