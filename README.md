<p align="center"><img src="agent/assets/icon.png" width="96" alt="EasyPrint"></p>

<h1 align="center">EasyPrint</h1>

<p align="center">
  Impressão direta do navegador para impressoras térmicas, de etiqueta e comuns.<br>
  Cupons, etiquetas ZPL, PDF e HTML, sem janela de impressão, com acentos certos e em português.
</p>

<p align="center">
  <a href="https://github.com/GuiVicS/easyprint/releases/latest/download/EasyPrint.exe"><b>Baixar para Windows</b></a> ·
  <a href="#linux">Linux</a> ·
  <a href="https://guivics.github.io/easyprint/docs/">Documentação</a> ·
  <a href="https://guivics.github.io/easyprint/">Site</a>
</p>

---

```
 Site / ERP (SDK easyprint.js) ─ws://127.0.0.1:17777─► EasyPrint ──► térmica (ESC/POS)
 Back-end (easyprint-cloud.js) ─► Relay HTTPS ◄─busca─┘   │       ├─► etiqueta (ZPL)
                                                          │       ├─► impressora comum (PDF/HTML/texto)
                                     assistente · painel · finalidades · fila · histórico
```

## Recursos

- **Documento universal:** título, item, total, QR, código de barras e imagem. O mesmo código imprime em térmica de 58 ou 80 mm, em etiqueta ou em A4.
- **PDF, HTML e ZPL:** DANFE, etiquetas de marketplace (Mercado Livre, Correios, Shopee) e comandas em HTML. Códigos de barras saem nítidos, sem pontilhado.
- **Acentos corretos:** tabelas CP860, CP850 e CP1252 explícitas, com teste guiado no assistente.
- **Finalidades:** o sistema diz *o que* imprime (`etiqueta`, `danfe`, `pedido`) e o lojista escolhe *onde*.
- **Impressão pela nuvem:** o ERP imprime pelo servidor, sem tela aberta, com trabalhos assinados (Ed25519), anti-replay e validade.
- **Assistente em pt-BR:** detecta a impressora, imprime o teste e corrige problemas. Tem também o **Simulador** para testar sem papel.
- **Leve:** um executável. Sem Java, sem administrador, sem certificado raiz, sem regra de firewall.
- **Windows e Linux:** no Linux, usa o CUPS e térmicas USB diretas (`/dev/usb/lp*`).

## Instalação

**Windows 10/11:** baixe o [`EasyPrint.exe`](https://github.com/GuiVicS/easyprint/releases/latest/download/EasyPrint.exe) e abra. Ele se instala em `%LOCALAPPDATA%\Programs\EasyPrint`, cria atalhos e abre o assistente.
> Como o executável ainda não tem assinatura digital, o SmartScreen pode avisar na primeira vez: clique em **Mais informações → Executar assim mesmo**.

<a id="linux"></a>**Linux x64:**
```sh
curl -fsSL https://github.com/GuiVicS/easyprint/raw/main/install.sh | sh
```
O script instala em `~/.local/bin/easyprint` e cria o atalho no menu. Dependências opcionais: `cups` (impressoras do sistema), `poppler-utils` (PDF em térmica/etiqueta), `chromium` (HTML).

## Uso no seu sistema

```html
<script src="/vendor/easyprint.js"></script>
<script>
  const printer = EasyPrint.connect({
    appName: 'Minha Loja',
    routes: { pedido: 'Pedidos', etiqueta: 'Etiquetas de envio', danfe: 'Notas fiscais' },
  });

  await printer.print(
    EasyPrint.receipt().title('PEDIDO #1').item(2, 'X-Burguer', 'R$ 59,80', 'sem cebola').total('TOTAL', 'R$ 59,80').cut(),
    { route: 'pedido' }
  );
  await printer.printRaw(zplDoMercadoLivre, { route: 'etiqueta' });
  await printer.printPdf('/notas/123/danfe.pdf', { route: 'danfe' });
  await printer.printHtml(document.querySelector('#comanda'));
</script>
```

| Arquivo | Para quê |
|---|---|
| `sdk/easyprint.js` + `.d.ts` | SDK do navegador (UMD; funciona com `<script>`, `import` e `require`) |
| `cloud/easyprint-cloud.js` | SDK de servidor: cria dispositivos e envia trabalhos assinados |
| `cloud/relay-server.js` | Relay de referência (fila HTTPS), sem dependências |
| `EASYPRINT_AI.md` | Guia completo para qualquer IA integrar o EasyPrint por você |
| `skill/easyprint/` | A mesma orientação no formato de skill (Claude Code) |

A documentação completa, com playground, receitas para React, Next, Vue, Angular e Svelte, ERP e nuvem, está em **[guivics.github.io/easyprint/docs](https://guivics.github.io/easyprint/docs/)**. Ela também abre no próprio app, em `http://127.0.0.1:17777/docs/`.

## Segurança

- **Rede:** o agente escuta só em `127.0.0.1`.
- **Navegador:** cada site (`Origin`) precisa ser aprovado uma vez pelo lojista.
- **Painel:** exige token por execução, com checagem de `Host` contra DNS rebinding e de `Origin` contra CSRF.
- **Nuvem:**
  - trabalhos assinados com Ed25519 e amarrados ao `deviceId`;
  - validade máxima de 7 dias;
  - anti-replay persistido em disco;
  - gaveta bloqueada por padrão;
  - token protegido com DPAPI no Windows e em arquivo `0600` no Linux.
- **HTML:** renderizado em navegador headless com perfil separado e JavaScript bloqueado por CSP.

Encontrou uma falha? Abra uma [issue](https://github.com/GuiVicS/easyprint/issues) marcada como segurança, ou entre em contato pelo perfil do mantenedor.

## Desenvolvimento

Requer Node 22+. Nenhuma dependência npm em tempo de execução.

```bash
npm run dev         # agente a partir do código-fonte (abre o assistente)
npm test            # 43 testes: renderização, segurança, nuvem com ataques simulados, PDF/HTML, SDK
npm run build       # dist/: agente em 1 arquivo, SDK (UMD/ESM/tipos), skill .zip, EASYPRINT_AI.md
npm run build:exe   # + dist/EasyPrint.exe (ícone, sem console) e dist/easyprint-linux-x64 (via Docker)
node build.js --site  # docs/: site do GitHub Pages
node examples/serve.js  # loja de demonstração em http://127.0.0.1:5500
```

| Pasta | Conteúdo |
|---|---|
| `agent/src` | Agente: servidor HTTP/WebSocket, segurança, fila, nuvem, renderizadores (ESC/POS, ZPL, PNG, PDF, HTML, acentos) |
| `agent/assets` | Painel/assistente, documentação, ícone e helpers do Windows (winspool, GDI, PDF nativo, DPAPI, bandeja) |
| `sdk` · `cloud` | SDK do navegador · SDK de servidor e relay |
| `skill/easyprint` | Skill de IA (fonte do `EASYPRINT_AI.md`) |
| `site` · `docs` | Fonte da landing page · site gerado para o GitHub Pages |
| `test` | Testes `node:test` |

## Limitações conhecidas

- Não acessa serial, USB nem HID diretamente (balanças, leitores). O foco é impressão.
- No macOS, o suporte é básico, via CUPS, e não há binário pronto. Rode com `npm run dev`.
- No Safari com HTTPS, sites não conseguem falar com `ws://127.0.0.1`. Use Chrome, Edge ou Firefox.
- O QR Code nativo usa o comando Epson `GS ( k`. Algumas Bematech em modo nativo precisam do modo ESC/POS.
- O executável ainda não tem assinatura digital de código.

## Licença

[MIT](LICENSE). Use, modifique e distribua, inclusive em projetos comerciais.
