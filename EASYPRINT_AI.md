<!-- EASYPRINT_AI.md — gerado por build.js a partir de skill/easyprint. Entregue este arquivo a qualquer IA. -->
# EasyPrint — guia de integração para IAs

Você vai integrar o **EasyPrint** num projeto web. O EasyPrint é um programa que roda no computador da loja e deixa sites autorizados imprimirem direto na impressora. Seu trabalho é adicionar o **SDK** (um arquivo JavaScript) ao projeto e criar a impressão do jeito certo.

> **Como o EasyPrint funciona (resumo para você)**
> - O usuário instala o EasyPrint e escolhe a impressora num assistente. Você **não** configura impressora no código.
> - O site conecta via SDK em `ws://127.0.0.1:17777`. Na primeira vez, o EasyPrint pergunta ao usuário se aquele site pode imprimir.
> - Você monta um **documento universal** (blocos como título, item, total, QR). O EasyPrint converte para a impressora certa: ESC/POS em térmicas, ZPL em etiquetas ou desenho em impressora comum. Os acentos (ç, ã) saem corretos.

Arquivos desta skill:
- `easyprint.js` (código completo no Anexo A): o SDK (UMD; funciona com `<script>`, `import` e `require`)
- `easyprint.d.ts` (Anexo B): os tipos TypeScript
- a seção "Referência da API" abaixo: a API completa e todos os blocos do documento
- a seção "Modelos por framework" abaixo: modelos prontos para React, Next.js, Vue/Nuxt, Angular, Svelte e HTML puro
- a seção "Status e erros" abaixo: status, códigos de erro e o que mostrar ao usuário
- a seção "ERP e e-commerce" abaixo: ERP/e-commerce — PDF, HTML, ZPL de marketplace, finalidades e impressão pelo servidor (nuvem)

---

## Passo 0 — Entenda o projeto antes de escrever código

1. **Framework:** leia o `package.json`. Os sinais são `next`, `react`, `nuxt`, `vue`, `@angular/core` e `svelte`/`@sveltejs/kit`. Sem `package.json` (ou sem bundler), é HTML puro.
2. **TypeScript?** Procure `tsconfig.json`.
3. **O que imprimir:** encontre onde o pedido, a venda ou o recibo é exibido ou salvo. Anote os campos: número, itens (quantidade, nome, preço, observação), totais, cliente, endereço, pagamento.
4. **Impressão existente:** procure `window.print`, `qz-tray`, `qz.print`, `printJS` e `<iframe>` de impressão. Você vai substituir ou complementar isso.
5. Se algo essencial for ambíguo (por exemplo, quais dados vão no cupom), pergunte ao usuário. Se não for, siga os padrões abaixo.

## Passo 1 — Adicione o SDK ao projeto

Copie `easyprint.js` (código completo no Anexo A) e `easyprint.d.ts` (Anexo B) para o projeto:

| Tipo de projeto | Onde colocar | Como carregar |
|---|---|---|
| Com bundler (Vite, Next, Webpack, Angular CLI…) | `src/lib/easyprint/easyprint.js` (+ `.d.ts` ao lado) | `import EasyPrint from './easyprint/easyprint.js'` |
| HTML puro / PHP / Django / Rails templates | `public/vendor/easyprint.js` (pasta de estáticos) | `<script src="/vendor/easyprint.js"></script>` → `window.EasyPrint` |

**Não** carregue o SDK de `http://127.0.0.1:17777/easyprint.js` em produção: se o EasyPrint estiver fechado, o script não carrega e você perde a mensagem de "EasyPrint não está aberto".

## Passo 2 — Crie UM serviço de impressão (singleton)

Crie um módulo central, por exemplo `src/lib/printing.(ts|js)`, com:

```ts
import EasyPrint from './easyprint/easyprint.js';

// Conecta uma única vez. O SDK reconecta sozinho se o EasyPrint for fechado/aberto.
export const printer = EasyPrint.connect({
  appName: 'NOME DO SISTEMA',                  // aparece na janela de permissão
  downloadUrl: 'https://github.com/GuiVicS/easyprint/releases/latest', // mostrado se não estiver instalado
  routes: { pedido: 'Pedidos', etiqueta: 'Etiquetas de envio' },       // finalidades: o lojista escolhe a impressora de cada uma
});

export async function printOrder(order) {
  return printer.print(orderToReceipt(order), { jobName: `Pedido ${order.number}` });
}
```

Regras:
- Chame `EasyPrint.connect()` **uma vez** (no módulo). Nunca chame dentro de cada clique.
- Em SSR (Next.js, Nuxt, SvelteKit, Angular Universal), só conecte no navegador. Veja a seção "Modelos por framework" abaixo.
- **Não** fixe nome de impressora no código. Use **finalidades**: declare em `routes` e mande `{ route: 'etiqueta' }` em cada impressão; o lojista escolhe a impressora de cada finalidade no painel do EasyPrint. Sem configuração, sai na impressora padrão.

## Passo 3 — Converta os dados do domínio em documento

Use o builder `EasyPrint.receipt()`:

```ts
const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function orderToReceipt(order) {
  const r = EasyPrint.receipt()
    .title(`PEDIDO #${order.number}`)
    .center(new Date(order.createdAt).toLocaleString('pt-BR'))
    .line();
  for (const it of order.items) r.item(it.quantity, it.name, brl(it.total), it.notes);
  r.line()
    .row('Subtotal', brl(order.subtotal))
    .row('Entrega', brl(order.deliveryFee))
    .total('TOTAL', brl(order.total))
    .line()
    .text(`Cliente: ${order.customer.name}`)
    .text(`Endereço: ${order.address}`)
    .text(`Pagamento: ${order.paymentMethod}`)
    .qr(order.trackingUrl)   // só se existir
    .cut();
  return r;
}
```

Regras de layout:
- **Não** preencha espaços nem centralize "na mão". Use `align`, `row`, `item` e `total`. O EasyPrint calcula as colunas (58 mm = 32, 80 mm = 48).
- Formate dinheiro com `Intl`/`toLocaleString('pt-BR')`. Acentos e `R$` saem corretos.
- Omita blocos com dados vazios (sem QR se não houver URL, sem observação se estiver vazia).
- Termine com `.cut()`. Em térmicas, o EasyPrint corta automaticamente se você esquecer.
- Para logo, use `await EasyPrint.image('/logo.png')` → `.image(dataUrl)`. A imagem precisa ser do mesmo domínio ou ter CORS.

### Já tem PDF, HTML ou ZPL pronto? Use direto
- PDF (DANFE, etiqueta de marketplace, boleto): `printer.printPdf(url | Blob | bytes, { route: 'danfe', pages: '1' })`
- HTML (comanda/layout pronto): `printer.printHtml(elementoOuString, { route: 'pedido' })`. O JavaScript fica desligado na renderização.
- ZPL/ESC-POS (ex.: etiqueta do Mercado Livre): `printer.printRaw(zpl, { route: 'etiqueta' })`
- ERP/e-commerce e impressão automática pelo servidor: siga a seção "ERP e e-commerce" abaixo.

## Passo 4 — Mostre o status da impressora na interface

O usuário precisa saber se dá para imprimir e, se não der, **como resolver**. Escolha uma das opções:

- **Rápida:** `EasyPrint.widget(printer, '#easyprint-status')`. É um selo pronto ("● Impressora pronta") que, ao ser clicado, mostra os passos de correção.
- **Integrada ao design system:** escute `printer.on('status', (status, diagnosis) => ...)` e mostre `diagnosis.title`, `diagnosis.message` e a lista `diagnosis.steps`.

O botão "Imprimir" deve continuar **habilitado** mesmo quando não estiver pronto. Ao clicar, se der erro, mostre a mensagem e a dica (Passo 5). Ofereça `window.print()` como alternativa quando fizer sentido.

## Passo 5 — Trate erros mostrando a dica ao usuário

Todo erro do SDK tem `code`, `message` (o que houve) e `hint` (como resolver, em pt-BR). Mostre os dois:

```ts
try {
  await printOrder(order);
  toast.success('Pedido enviado para a impressora');
} catch (err) {
  toast.error(err.message + (err.hint ? ` — ${err.hint}` : ''));
}
```

Os códigos e quando tratar de forma especial estão em a seção "Status e erros" abaixo.

## Passo 6 (opcional) — Impressão automática de novos pedidos

Se o sistema recebe pedidos em tempo real (websocket, Supabase Realtime, polling):
- Imprima só quando `printer.status === 'ready'`. Se não estiver pronto, guarde numa fila e imprima no evento `printer.on('ready', ...)`.
- **Evite duplicar:** registre os IDs já impressos (no `localStorage` ou numa coluna `printed_at` no banco) antes de imprimir de novo.
- Dê ao usuário um botão para desligar a impressão automática.
- Se a impressão precisa acontecer **sem nenhuma tela aberta**, use a impressão pelo servidor (a seção "ERP e e-commerce" abaixo → Impressão pelo servidor).

## Passo 7 — Verifique

1. Rode o projeto e abra a tela com impressão.
2. Com o EasyPrint aberto, clique em imprimir. Aprove o site na janela do EasyPrint e no navegador ("acessar apps neste dispositivo").
3. Sem impressora física: escolha **"EasyPrint Simulador"** no assistente e veja o resultado em **Painel → Histórico**.
4. Feche o EasyPrint e confira se a interface mostra "O EasyPrint não está aberto" com os passos.
5. Se o projeto tiver testes, troque o cliente por um mock (veja a seção "Modelos por framework" abaixo → "Testes").

## Não faça

- ❌ Abrir `new WebSocket('ws://127.0.0.1:17777')` direto. Use o SDK, que já trata portas, reconexão, permissões e mensagens.
- ❌ Montar bytes ESC/POS na mão, a menos que o usuário peça um comando específico (use `printRaw` nesse caso).
- ❌ Chamar `connect()` a cada impressão ou em componentes que re-renderizam.
- ❌ Deixar o usuário sem resposta: todo `print()` precisa de `try/catch` com feedback.
- ❌ Esconder o erro do navegador "acesso à rede local". Mostre os `steps` do `diagnose()`.

Quando terminar, resuma para o usuário: os arquivos criados ou alterados, como testar (Simulador) e o que o lojista precisa fazer (instalar o EasyPrint, rodar o assistente e permitir o site).


---

# Referência da API

## `EasyPrint.connect(options?) → client`

Conecta ao EasyPrint. Se você chamar de novo, recebe o mesmo cliente (a menos que passe `fresh: true`).

| Opção | Padrão | Para que serve |
|---|---|---|
| `appName` | `null` | Nome do seu sistema, mostrado na janela de permissão. |
| `downloadUrl` | `null` | Link de download exibido quando o EasyPrint não está instalado. |
| `routes` | `null` | Finalidades que o sistema usa: `{ etiqueta: 'Etiquetas de envio' }`. O lojista escolhe a impressora de cada uma. |
| `ports` | `[17777, 17778, 17779]` | Portas onde o SDK procura o EasyPrint. |
| `host` | `'127.0.0.1'` | Endereço do EasyPrint (sempre local). |
| `token` | `null` | Só para apps **sem navegador** ou páginas `file://`. É criado no painel em "Apps locais". |
| `autoReconnect` | `true` | Reconecta sozinho quando o EasyPrint é reaberto. |
| `requestTimeout` | `60000` | Tempo máximo de cada operação (ms). |
| `debug` | `false` | Mostra logs no console. |

## Cliente

| Membro | Descrição |
|---|---|
| `client.status` | `'connecting' \| 'ready' \| 'not_running' \| 'browser_blocked' \| 'awaiting_approval' \| 'denied' \| 'unsupported_browser' \| 'disconnected'` |
| `client.on('status', (status, diagnosis) => {})` | Avisa quando o status muda (e já chama na hora com o atual). Retorna uma função para cancelar. |
| `client.on('ready', () => {})` | Avisa quando fica pronto para imprimir. |
| `client.ready(timeoutMs?)` | Promise que resolve quando está pronto e rejeita com um erro explicativo. Se estiver aguardando permissão, espera até 2 min. |
| `client.print(doc, opts?)` | Imprime um builder, `{ blocks }`, um array de blocos ou uma string. |
| `client.printText(text, opts?)` | Imprime texto simples. |
| `client.printImage(src, opts?)` | Imprime uma imagem (URL, `<img>`, `<canvas>` ou data URL). |
| `client.printRaw(data, opts?)` | Envia bytes crus (ESC/POS, ZPL, EPL…). `data`: string binária, `Uint8Array`, `ArrayBuffer`, array misto, `{hex}`, `{base64}` ou `{text}`. |
| `client.printPdf(source, opts?)` | Imprime PDF. `source`: URL (baixada com os cookies do site), data URL, `Blob`, `ArrayBuffer` ou `Uint8Array` (até 25 MB). `opts`: `pages` (`'1-3,5'`), `fit` (`'page'`/`'actual'`), `paperSize`. |
| `client.printHtml(html, opts?)` | Imprime HTML (string ou elemento da página, com os estilos dela). JavaScript desligado, a menos que `javascript: true`. |
| `client.routes()` | `[{ route, label, printer }]`: as finalidades e as impressoras escolhidas pelo lojista. |
| `client.printers()` | `PrinterInfo[]` com `name`, `kind`, `online`, `isDefault`, `mode`, `paperWidth`, `columns`. |
| `client.defaultPrinter()` | A impressora padrão escolhida no EasyPrint. |
| `client.diagnose()` | `{ ok, status, title, message, steps[] }`, tudo em pt-BR e pronto para exibir. |
| `client.disconnect()` | Encerra a conexão. |

### Opções de impressão (`opts`)

| Opção | Descrição |
|---|---|
| `printer` | Nome ou parte do nome da impressora. Tem prioridade sobre `route`. |
| `route` | Finalidade (`'etiqueta'`, `'danfe'`, `'cozinha'`…). Sem configuração, usa a impressora padrão. |
| `copies` | Número de cópias (1–50). |
| `jobName` | Nome que aparece na fila do sistema e no histórico. |
| `options` | Sobrescreve o perfil só nesta impressão: `{ codepage, paperWidth, columns, autoCut }`. |

Retorna `{ jobId, printer, mode, status: 'done', routedBy, pages? }`. `routedBy` pode ser `'printer'`, `'route'`, `'default'` ou `'default-fallback'` (este último indica que a finalidade ainda não tem impressora escolhida).

## Documento universal

Um documento é `{ blocks: Block[] }`. Uma string solta conta como bloco de texto.

| Bloco | Builder | Resultado |
|---|---|---|
| `{type:'text', value, align, bold, size, underline, invert}` | `.text(v, opts)` / `.center(v)` / `.bold(v)` | Texto. `size` vai de 1 a 3; `align` pode ser `left`, `center` ou `right`. |
| `{type:'title', value}` | `.title(v)` | Texto grande, centralizado e em negrito. |
| `{type:'line', char}` | `.line('=')` | Linha separadora na largura do papel. |
| `{type:'row', left, right, bold, size}` | `.row('Subtotal', 'R$ 10,00')` | Duas colunas, com o valor alinhado à direita. |
| `{type:'item', qty, name, price, note}` | `.item(2, 'X-Burguer', 'R$ 30,00', 'sem cebola')` | Item de pedido com a observação recuada embaixo. |
| `{type:'total', label, value}` | `.total('TOTAL', 'R$ 70,80')` | Total em destaque. |
| `{type:'qr', value, size}` | `.qr(url, 6)` | QR Code (`size` de 1 a 16). |
| `{type:'barcode', value, format}` | `.barcode('789...', 'EAN13')` | Código de barras `CODE128` ou `EAN13`. |
| `{type:'image', src, align, width}` | `.image(pngDataUrl)` | Imagem PNG em data URL (use `EasyPrint.image()`). |
| `{type:'feed', lines}` | `.feed(3)` | Avança o papel. |
| `{type:'cut'}` | `.cut()` | Corta o papel (em térmicas). |
| `{type:'drawer'}` | `.drawer()` | Abre a gaveta de dinheiro ligada à impressora. |

### Como cada tipo de impressora renderiza

| Tipo (definido no assistente) | Saída |
|---|---|
| Cupom / térmica (`escpos`) | Bytes ESC/POS com a tabela de acentos escolhida (CP860 por padrão), QR nativo e imagem em raster. |
| Etiqueta (`zpl`) | ZPL em UTF-8 (`^CI28`). |
| Folha comum (`office`) | Desenho via driver do sistema, com fonte monoespaçada e imagens. |

PDF e HTML funcionam nos quatro tipos. Na térmica e na etiqueta, eles são rasterizados com limiar (sem pontilhado) para manter código de barras e QR legíveis. No HTML para térmica, o espaço em branco do fim é cortado.
| Simulador (`virtual`) | Nada é impresso. A pré-visualização aparece em Painel → Histórico. |

## Utilidades

- `EasyPrint.receipt()`: cria um builder encadeável (`.build()` devolve o documento).
- `await EasyPrint.image(src, maxWidth = 576)`: converte uma imagem em PNG data URL com fundo branco.
- `EasyPrint.widget(client, elementOrSelector, { align, readyLabel })`: selo de status com instruções de correção (usa Shadow DOM, sem conflito de CSS). Retorna uma função para remover o listener.
- `EasyPrint.messages`: textos de cada status (para customizar a interface).


---

# Modelos por framework

Todos os modelos assumem o SDK copiado em `src/lib/easyprint/easyprint.js` (com o `.d.ts` ao lado). Ajuste os caminhos e os nomes dos campos do pedido ao projeto.

---

## HTML puro (sem bundler)

```html
<script src="/vendor/easyprint.js"></script>
<span id="easyprint-status"></span>
<button id="btn-print">Imprimir pedido</button>
<script>
  const printer = EasyPrint.connect({ appName: 'Minha Loja', downloadUrl: 'https://minhaloja.com/easyprint' });
  EasyPrint.widget(printer, '#easyprint-status');

  document.getElementById('btn-print').addEventListener('click', async () => {
    try {
      await printer.print(
        EasyPrint.receipt().title('PEDIDO #123').line()
          .item(2, 'X-Burguer', 'R$ 59,80', 'sem cebola')
          .total('TOTAL', 'R$ 59,80').cut()
      );
      alert('Enviado para a impressora!');
    } catch (err) {
      alert(err.message + (err.hint ? '\n\n' + err.hint : ''));
    }
  });
</script>
```

---

## React (Vite / CRA)

`src/lib/printing.ts`
```ts
import EasyPrint from './easyprint/easyprint.js';
export { EasyPrint };
export const printer = EasyPrint.connect({ appName: 'Minha Loja' });
```

`src/hooks/useEasyPrint.ts`
```ts
import { useEffect, useState } from 'react';
import { printer } from '../lib/printing';
import type { Diagnosis } from '../lib/easyprint/easyprint';

export function useEasyPrint() {
  const [diagnosis, setDiagnosis] = useState<Diagnosis>(printer.diagnose());
  useEffect(() => printer.on('status', (_s, d) => setDiagnosis(d)), []);
  return { printer, diagnosis, ready: diagnosis.ok };
}
```

`src/components/PrinterStatus.tsx`
```tsx
import { useState } from 'react';
import { useEasyPrint } from '../hooks/useEasyPrint';

export function PrinterStatus() {
  const { diagnosis } = useEasyPrint();
  const [open, setOpen] = useState(false);
  return (
    <div className="printer-status">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ color: diagnosis.ok ? 'green' : 'orange' }}>●</span> {diagnosis.ok ? 'Impressora pronta' : diagnosis.title}
      </button>
      {open && !diagnosis.ok && (
        <div role="dialog">
          <p>{diagnosis.message}</p>
          <ol>{diagnosis.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
      )}
    </div>
  );
}
```

Botão de imprimir:
```tsx
const [busy, setBusy] = useState(false);
async function handlePrint() {
  setBusy(true);
  try { await printer.print(orderToReceipt(order), { jobName: `Pedido ${order.number}` }); toast.success('Impresso!'); }
  catch (err: any) { toast.error(`${err.message}${err.hint ? ' — ' + err.hint : ''}`); }
  finally { setBusy(false); }
}
```

---

## Next.js (App Router)

O SDK só existe no navegador. Conecte apenas em componentes `'use client'` e **nunca** no topo de um módulo importado por Server Components.

`src/lib/printing.ts`
```ts
'use client';
import type { EasyPrintClient } from './easyprint/easyprint';

let client: EasyPrintClient | null = null;
export async function getPrinter() {
  if (typeof window === 'undefined') throw new Error('EasyPrint só funciona no navegador');
  if (!client) {
    const { default: EasyPrint } = await import('./easyprint/easyprint.js');
    client = EasyPrint.connect({ appName: 'Minha Loja' });
  }
  return client;
}
```

Hook:
```tsx
'use client';
import { useEffect, useState } from 'react';
import { getPrinter } from '@/lib/printing';

export function useEasyPrint() {
  const [diagnosis, setDiagnosis] = useState<any>({ ok: false, status: 'connecting', title: 'Conectando…', message: '', steps: [] });
  useEffect(() => {
    let off = () => {};
    getPrinter().then((p) => { off = p.on('status', (_s, d) => setDiagnosis(d)); });
    return () => off();
  }, []);
  return diagnosis;
}
```

Para imprimir: `const p = await getPrinter(); await p.print(...)`. O builder fica em `(await import('./easyprint/easyprint.js')).default.receipt()`, ou monte o documento como objeto `{ blocks: [...] }`, que não precisa importar nada.

---

## Vue 3 / Nuxt 3

`src/composables/useEasyPrint.ts`
```ts
import { ref, onMounted, onBeforeUnmount } from 'vue';
import EasyPrint from '@/lib/easyprint/easyprint.js';

let printer: ReturnType<typeof EasyPrint.connect> | null = null;

export function useEasyPrint() {
  const diagnosis = ref({ ok: false, title: 'Conectando…', message: '', steps: [] as string[], status: 'connecting' });
  let off = () => {};
  onMounted(() => {
    printer ??= EasyPrint.connect({ appName: 'Minha Loja' });
    off = printer.on('status', (_s, d) => (diagnosis.value = d));
  });
  onBeforeUnmount(() => off());
  const print = (doc: any, opts?: any) => printer!.print(doc, opts);
  return { diagnosis, print, EasyPrint };
}
```

No Nuxt, use o composable apenas em componentes client-side (`<ClientOnly>`) ou num plugin `plugins/easyprint.client.ts`.

---

## Angular

`src/app/printing.service.ts`
```ts
import { Injectable, NgZone, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import EasyPrint from '../lib/easyprint/easyprint.js';

@Injectable({ providedIn: 'root' })
export class PrintingService {
  private zone = inject(NgZone);
  private client = isPlatformBrowser(inject(PLATFORM_ID)) ? EasyPrint.connect({ appName: 'Minha Loja' }) : null;
  diagnosis = signal(this.client?.diagnose() ?? null);

  constructor() {
    this.client?.on('status', (_s, d) => this.zone.run(() => this.diagnosis.set(d)));
  }

  receipt() { return EasyPrint.receipt(); }
  print(doc: any, opts?: any) {
    if (!this.client) return Promise.reject(new Error('Impressão indisponível no servidor'));
    return this.client.print(doc, opts);
  }
}
```

Se o TypeScript reclamar do `.js`, adicione `"allowJs": true` ou declare o módulo usando o `easyprint.d.ts`.

---

## Svelte / SvelteKit

`src/lib/printing.ts`
```ts
import { readable } from 'svelte/store';
import { browser } from '$app/environment';
import EasyPrint from './easyprint/easyprint.js';

export const printer = browser ? EasyPrint.connect({ appName: 'Minha Loja' }) : null;
export const printerStatus = readable(printer?.diagnose() ?? null, (set) => (printer ? printer.on('status', (_s, d) => set(d)) : undefined));
export { EasyPrint };
```

---

## Back-end local / Electron / scripts (sem navegador)

Crie um token no painel do EasyPrint (**Sites e apps → Apps locais**) e passe em `connect`:

```js
const EasyPrint = require('./easyprint.js'); // Node 22+ tem WebSocket global
const printer = EasyPrint.connect({ token: process.env.EASYPRINT_TOKEN, appName: 'Servidor da loja' });
await printer.print({ blocks: ['Olá do servidor!', { type: 'cut' }] });
```

---

## Testes (mock do cliente)

```ts
const fakePrinter = {
  status: 'ready',
  print: vi.fn().mockResolvedValue({ jobId: 'x', printer: 'Simulador', mode: 'virtual', status: 'done' }),
  on: (_e: string, fn: Function) => { fn('ready', { ok: true, status: 'ready', title: '', message: '', steps: [] }); return () => {}; },
  diagnose: () => ({ ok: true, status: 'ready', title: '', message: '', steps: [] }),
};
vi.mock('@/lib/printing', () => ({ printer: fakePrinter }));
```

Teste também a conversão `orderToReceipt(order).build()`. O resultado é um objeto JSON simples, fácil de comparar com um snapshot.


---

# Status e erros

## Status do cliente (`client.status`)

| Status | O que significa | O que a interface deve fazer |
|---|---|---|
| `connecting` | Procurando o EasyPrint. | Mostrar "Conectando…" (dura menos de 1 s). |
| `ready` | Conectado e autorizado. | Indicador verde. Pode imprimir. |
| `not_running` | O EasyPrint não está aberto ou não foi instalado. | Mostrar os `steps` e o link de download. O SDK tenta de novo sozinho. |
| `browser_blocked` | O usuário bloqueou "acesso à rede local" no Chrome/Edge. | Mostrar os passos: cadeado → Acesso à rede local → Permitir → recarregar. |
| `awaiting_approval` | O EasyPrint está perguntando se o site pode imprimir. | "Confirme no EasyPrint". Quando aprovado, vira `ready` sozinho. |
| `denied` | O site foi bloqueado no EasyPrint (ou o token é inválido). | Passos para desbloquear em "Sites e apps". |
| `unsupported_browser` | Safari em HTTPS. | Sugerir Chrome, Edge ou Firefox. |
| `disconnected` | O EasyPrint foi fechado durante o uso. | "Reconectando…". |

Use `client.diagnose()` para pegar `title`, `message` e `steps` já escritos em pt-BR.

## Códigos de erro (`err.code`)

| Código | Quando acontece | Sugestão de tratamento |
|---|---|---|
| `NOT_RUNNING` | Imprimiu com o EasyPrint fechado. | Mostrar `err.message` + `err.hint`. Oferecer `window.print()`. |
| `BROWSER_BLOCKED` | O navegador está bloqueando o acesso local. | Mostrar os passos do `diagnose()`. |
| `NOT_AUTHORIZED` | A permissão não foi dada a tempo. | "Clique em Permitir na janela do EasyPrint". |
| `DENIED` | O site está bloqueado. | Passos para desbloquear. |
| `PRINTER_NOT_FOUND` | A impressora indicada não existe ou está desligada. | A `hint` lista as impressoras disponíveis. Peça para escolher outra. |
| `NO_DEFAULT_PRINTER` | Ninguém escolheu a impressora padrão. | "Abra o EasyPrint e rode o assistente". |
| `PRINT_FAILED` | O sistema operacional recusou o trabalho. | Mostrar a `hint` (papel, tampa, cabo, fila do Windows). |
| `INVALID_DOCUMENT` | Bloco com tipo ou campo errado. | **Bug no código** — corrija o documento. |
| `TIMEOUT` | A impressora não respondeu. | Pedir para conferir a impressora e tentar de novo. |
| `DISCONNECTED` | A conexão caiu no meio da impressão. | Tentar novamente. |
| `INVALID_TOKEN` / `ORIGIN_REQUIRED` | App local sem token válido. | Criar o token no painel → "Apps locais". |
| `TOO_LARGE` | PDF acima de 25 MB, HTML acima de 5 MB ou RAW acima de 10 MB. | Imprimir menos páginas (`pages`). |
| `UNSUPPORTED` | Falta um componente do sistema (Linux: `poppler-utils` para PDF em térmica; Chrome/Chromium para HTML). | Mostrar a `hint`, que traz o comando de instalação. |
| `INVALID_ROUTE` | Nome de finalidade inválido. | **Bug no código**: use `[a-z0-9_-]`. |
| `POLICY_BLOCKED` | Abrir a gaveta (ou RAW/PDF na nuvem) não está liberado para este site, app ou conexão. | O lojista libera em EasyPrint → Sites e apps (ou Nuvem) → "Abrir gaveta". |
| `RATE_LIMITED` | Mais de 120 impressões por minuto (ou 2000 por hora) da mesma origem. | Em lotes grandes, espaçar os envios. Se não for esperado, pode ser um site invadido. |
| `NOT_PAIRED` / `KEY_MISMATCH` | (SDK de servidor) A loja ainda não conectou, ou a chave da loja no relay não confere. | `NOT_PAIRED`: peça para colar o código. `KEY_MISMATCH`: **não** reenvie e investigue o relay. |

## Problemas comuns na loja

- **Acentos errados na térmica:** Painel → Impressoras → Ajustar → Acentos. Teste CP860 e depois CP850. O assistente faz isso automaticamente.
- **Texto cortado:** a largura do papel está errada (58 ou 80 mm).
- **A impressora não aparece:** falta o driver do fabricante, ou instale "Generic / Text Only". No Linux, térmicas USB aparecem como "USB direto (lp0)". Se der erro de permissão, rode `sudo usermod -aG lp $USER` e entre de novo na sessão.
- **Finalidade saindo na impressora errada:** Painel → Impressoras → Finalidades.
- **Chrome perguntou "acessar apps neste dispositivo":** é normal; clique em Permitir.


---

# ERP e e-commerce

Para ERPs, lojas virtuais, PDVs e sistemas de expedição. Há dois jeitos de imprimir:

| Jeito | Quando usar | Como |
|---|---|---|
| **Pelo navegador** | O usuário clica em "Imprimir" (ou a tela aberta imprime pedidos novos) | SDK `easyprint.js` no front-end |
| **Pelo servidor (nuvem)** | Impressão automática sem nenhuma tela aberta (webhook de pedido, fila noturna, integração) | SDK de servidor `easyprint-cloud.js` + relay |

## Finalidades (rotas): o lojista escolhe a impressora

Não fixe o nome da impressora no código. Declare as **finalidades** que o sistema usa e mande cada impressão com `route`. O lojista escolhe a impressora de cada finalidade no painel (EasyPrint → Impressoras → Finalidades).

```js
const printer = EasyPrint.connect({
  appName: 'Meu ERP',
  routes: {
    pedido: 'Pedidos (cozinha/balcão)',
    etiqueta: 'Etiquetas de envio',
    danfe: 'Notas fiscais (DANFE)',
    produto: 'Etiquetas de produto',
  },
});
await printer.printPdf(urlDanfe, { route: 'danfe' });
```

- Uma finalidade sem impressora escolhida usa a padrão, e o resultado vem com `routedBy: 'default-fallback'`. Mostre um aviso como "Configure a impressora de etiquetas no EasyPrint".
- `printer: 'nome'` tem prioridade sobre `route`. Use só quando o usuário escolheu explicitamente.
- Nomes de finalidade: letras minúsculas, números, `-` e `_` (até 40 caracteres).

## Receitas

### Etiqueta do Mercado Livre / Mercado Envios (ZPL)
A API do Mercado Livre devolve a etiqueta em ZPL (`response_type=zpl2`). Envie como está:
```js
const zpl = await fetch(`/api/pedidos/${id}/etiqueta?formato=zpl`).then((r) => r.text()); // seu back-end busca no ML
await printer.printRaw(zpl, { route: 'etiqueta', jobName: `Etiqueta ${id}` });
```

### Etiqueta em PDF (Correios, Shopee, Amazon, Melhor Envio…)
```js
await printer.printPdf(`/api/pedidos/${id}/etiqueta.pdf`, { route: 'etiqueta' });
```
Numa impressora de etiqueta (Zebra/ZPL), cada página do PDF vira uma etiqueta no tamanho configurado (ex.: 100 × 150 mm), com código de barras nítido (sem pontilhado).

### DANFE / boleto / relatório (PDF em A4)
```js
await printer.printPdf(urlDanfe, { route: 'danfe', pages: '1', paperSize: 'A4' });
```
A URL é baixada pelo **navegador**, com os cookies do seu site. Endpoints autenticados funcionam sem configuração extra.

### NFC-e / cupom não fiscal (térmica)
Monte com o documento universal: itens, totais, chave de acesso em texto e QR Code da consulta.
```js
const r = EasyPrint.receipt().title(loja.nome).center(`CNPJ ${loja.cnpj}`).line();
venda.itens.forEach((i) => r.item(i.qtd, i.descricao, brl(i.total)));
r.line().total('TOTAL', brl(venda.total)).row('Forma de pagamento', venda.pagamento)
 .line().center('Consulte pela chave de acesso em').center(nfce.urlConsulta)
 .text(nfce.chave.replace(/(\d{4})/g, '$1 ').trim(), { align: 'center' })
 .qr(nfce.qrCode).cut();
await printer.print(r, { route: 'pedido' });
```
O conteúdo fiscal exigido pela SEFAZ é responsabilidade do ERP. O EasyPrint só imprime.

### Comanda / layout pronto em HTML
```js
await printer.printHtml(document.querySelector('#comanda'), { route: 'pedido' });  // elemento da página (com os estilos)
await printer.printHtml('<h1>Mesa 7</h1><p>2x Pastel</p>', { route: 'pedido' });  // ou string
```
- O HTML é renderizado num navegador isolado, com **JavaScript desligado** (passe `javascript: true` só se o layout depender de JS).
- Na térmica, o HTML ocupa a largura do papel e o espaço em branco do fim é cortado.
- Na etiqueta, use o tamanho configurado. Na impressora comum, A4 ou `@page` do próprio HTML.

### Lote de etiquetas
O EasyPrint tem fila por impressora, então pode enviar em sequência:
```js
for (const p of pedidos) await printer.printRaw(p.zpl, { route: 'etiqueta', jobName: `Etiqueta ${p.id}` });
```

### Abrir a gaveta de dinheiro
```js
await printer.print(EasyPrint.receipt().drawer(), { route: 'pedido' });
```

---

## Impressão pelo servidor (nuvem)

Para imprimir sem nenhuma tela aberta. O fluxo:

```
 ERP (back-end) ──assina com Ed25519──► Relay (fila HTTPS) ◄──busca (só saída)── EasyPrint na loja ──► impressora
```

1. **Uma vez:** gere o par de chaves e guarde a privada como segredo (variável de ambiente ou cofre).
   ```js
   const { generateKeys } = require('./easyprint-cloud');
   console.log(generateKeys()); // { publicKey, privateKey }
   ```
2. **Suba o relay** (`cloud/relay-server.js`, sem dependências) atrás de HTTPS, com `RELAY_API_KEY` (≥ 32 caracteres). Você também pode implementar o protocolo abaixo no seu próprio back-end.
3. **Para cada loja/computador:** crie um dispositivo. Guarde `deviceId` e `deviceSecret` (este é **segredo**, como uma senha) no seu banco e mostre o código para o lojista colar em EasyPrint → Nuvem.
   ```js
   const cloud = new EasyPrintCloud({ relayUrl: process.env.EP_RELAY_URL, apiKey: process.env.EP_RELAY_KEY, privateKey: process.env.EP_PRIVATE_KEY, publicKey: process.env.EP_PUBLIC_KEY });
   const { deviceId, deviceSecret, connectionCode } = await cloud.createDevice('Loja Centro');
   // salve { deviceId, deviceSecret } da loja; exiba connectionCode (EPC2....) — ele só funciona UMA vez
   ```
   Depois que o lojista conectar, mostre `(await cloud.device(deviceId)).encryptionFingerprint` na sua tela para ele comparar com o que aparece no EasyPrint.
4. **Imprima** (o SDK cifra para a chave da loja e assina):
   ```js
   const device = { deviceId, deviceSecret };
   await cloud.print(device, { route: 'etiqueta', raw: { text: zpl } });
   await cloud.print(device, { route: 'danfe', pdf: pdfBuffer, pdfOptions: { pages: '1' } });
   await cloud.print(device, { route: 'pedido', document: { blocks: [...] }, copies: 2 });
   await cloud.print(device, { route: 'pedido', html: '<h1>Pedido 9</h1>' });
   const status = await cloud.waitJob(jobId); // done | failed | rejected
   const online = (await cloud.device(deviceId)).online;
   ```
   Erros do `print`: `NOT_PAIRED` (o lojista ainda não colou o código) e `KEY_MISMATCH` (a chave da loja no relay não confere: possível adulteração, nada é enviado).
   O builder `EasyPrint.receipt()` também funciona no Node: `require('./easyprint.js').receipt()...build()`.

### Garantias de segurança
- **Assinatura Ed25519:** só trabalhos assinados pela chave do seu sistema são impressos. Um relay invadido não consegue forjar impressões.
- **Criptografia de ponta a ponta:** cada trabalho é cifrado (X25519 + HKDF-SHA256 + AES-256-GCM) para uma chave gerada **no computador da loja**. O relay, e quem tiver acesso a ele, só vê bytes cifrados, sem nomes, endereços ou pedidos.
- **Chave da loja autenticada:** o `deviceSecret` (que nunca passa pelo relay) autentica a chave pública da loja. Se o relay tentar trocá-la, o `print` falha com `KEY_MISMATCH`.
- **Código de uso único:** no pareamento, o token do código é trocado por um definitivo. Uma foto do código depois de conectado não serve para nada.
- **Amarrado ao computador, com validade e anti-replay:** um trabalho da Loja A é recusado na Loja B. A validade é de 24 h por padrão (máx. 7 dias), e cada trabalho imprime uma única vez.
- **Políticas na loja:** "Abrir gaveta" vem desligado. "PDF/HTML" e "Comandos RAW" podem ser desligados. Há limite de 120 impressões por minuto por conexão.
- **Só conexões de saída, por HTTPS.** Os segredos do dispositivo ficam com DPAPI no Windows e em arquivo `0600` no Linux.

### Protocolo do relay (para implementar no seu back-end)
Pareamento (uma vez, com o `pairToken` do código): `POST /v1/agent/pair` ← `{ encryptionKey, keyMac }` → `{ token }`. O `pairToken` deixa de valer.
`keyMac = HMAC-SHA256(deviceSecret, "easyprint-device-key-v2:" + deviceId + ":" + encryptionKey)` (hex). O ERP confere antes de cifrar.

Agente → relay (`Authorization: Bearer <token do dispositivo>`):
- `GET /v1/agent/jobs?wait=25` → `{ jobs: [{ id, payload, signature }] }`, com long-polling de até 30 s.
- `POST /v1/agent/jobs/:id/result` ← `{ status: 'done'|'failed'|'rejected'|'duplicate', error?, printer?, pages? }`. `duplicate` significa que o trabalho já tinha sido impresso: trate como concluído.
- `POST /v1/agent/status` ← `{ agent, printers, routes }`, enviado a cada 5 min.

`payload` é um JSON (string) assinado com Ed25519: `{ v: 2, id, deviceId, ts, expiresAt, enc: { alg, epk, iv, ct, tag } }`.
- `enc` é o trabalho cifrado com X25519 efêmero + HKDF-SHA256 (salt = `epk`, info = `"easyprint-job-v2:" + id`) + AES-256-GCM (AAD = `id + ":" + deviceId`).
- O conteúdo decifrado é `{ route?, printer?, copies?, jobName?, document? | text? | image? | raw? | pdf? | html?, pdfOptions?, htmlOptions?, options? }`.

O relay deve recusar trabalhos sem `enc` e reentregar os que ficarem sem resultado depois de ~2 min. A implementação de referência está em `cloud/easyprint-cloud.js` (`signJob`, `encryptFor`).


---
# Anexo A — easyprint.js (crie este arquivo exatamente com este conteúdo)

```js
/*!
 * EasyPrint SDK v1.0.0 — impressão direta do navegador para impressoras locais.
 * Funciona via <script>, import ESM (bundlers) ou require (CommonJS). Sem dependências.
 *
 *   const printer = EasyPrint.connect({ appName: 'Minha Loja' });
 *   await printer.print(EasyPrint.receipt().title('PEDIDO #1').item(1, 'Pizza', 'R$ 50,00').cut());
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EasyPrint = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULTS = {
    appName: null,
    host: '127.0.0.1',
    ports: [17777, 17778, 17779],
    token: null,
    autoReconnect: true,
    downloadUrl: null,
    routes: null,
    requestTimeout: 60000,
    debug: false,
  };

  // ---------------------------------------------------------------------------
  // Mensagens (pt-BR) — cada status tem título, explicação e passos para resolver
  // ---------------------------------------------------------------------------
  var MESSAGES = {
    connecting: { title: 'Conectando ao EasyPrint…', message: 'Procurando o EasyPrint neste computador.', steps: [] },
    ready: { title: 'Impressora pronta', message: 'O EasyPrint está conectado e este site está autorizado.', steps: [] },
    not_running: {
      title: 'O EasyPrint não está aberto',
      message: 'Para imprimir direto na impressora, o EasyPrint precisa estar rodando neste computador.',
      steps: [
        'Procure o ícone verde do EasyPrint perto do relógio do Windows.',
        'Se ele não estiver lá, abra o EasyPrint pelo menu Iniciar.',
        'Ainda não instalou? Baixe e instale o EasyPrint — leva 2 minutos.',
      ],
    },
    browser_blocked: {
      title: 'O navegador bloqueou o acesso à impressora',
      message: 'O navegador está impedindo este site de falar com o EasyPrint no seu computador.',
      steps: [
        'Clique no ícone à esquerda do endereço do site (cadeado ou ajustes).',
        'Encontre "Acesso à rede local" ou "Apps neste dispositivo" e escolha "Permitir".',
        'Recarregue a página (F5).',
      ],
    },
    awaiting_approval: {
      title: 'Confirme no EasyPrint',
      message: 'Uma janela do EasyPrint abriu no seu computador perguntando se este site pode imprimir.',
      steps: ['Clique em "Permitir" na janela do EasyPrint.', 'Se a janela não apareceu, clique no ícone do EasyPrint perto do relógio.'],
    },
    denied: {
      title: 'Este site foi bloqueado no EasyPrint',
      message: 'Alguém clicou em "Bloquear" quando este site pediu permissão para imprimir.',
      steps: ['Abra o EasyPrint (ícone perto do relógio).', 'Vá em "Sites e apps" e clique em "Desbloquear" ao lado deste site.', 'Recarregue esta página.'],
    },
    unsupported_browser: {
      title: 'Navegador não suportado',
      message: 'O Safari não permite que sites conversem com programas locais.',
      steps: ['Use o Google Chrome, Microsoft Edge ou Firefox para imprimir direto.'],
    },
    disconnected: { title: 'Conexão perdida', message: 'A conexão com o EasyPrint caiu. Tentando reconectar…', steps: [] },
  };

  var ERROR_HINTS = {
    NOT_RUNNING: 'not_running', BROWSER_BLOCKED: 'browser_blocked', NOT_AUTHORIZED: 'awaiting_approval', DENIED: 'denied',
  };

  function EasyPrintError(code, message, hint) {
    var e = new Error(message);
    e.name = 'EasyPrintError';
    e.code = code;
    e.hint = hint || null;
    return e;
  }

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function toBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function rawToBase64(data) {
    if (typeof data === 'string') {
      var arr = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xff;
      return toBase64(arr);
    }
    if (data instanceof ArrayBuffer) return toBase64(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (Array.isArray(data)) {
      var parts = data.map(function (d) { return typeof d === 'number' ? [d] : Array.from(atob(rawToBase64(d)), function (c) { return c.charCodeAt(0); }); });
      return toBase64(Uint8Array.from([].concat.apply([], parts)));
    }
    throw EasyPrintError('INVALID_DOCUMENT', 'Formato de dados RAW não suportado.', 'Use string, Uint8Array, ArrayBuffer ou array.');
  }

  function isSafariHttps() {
    if (typeof navigator === 'undefined' || typeof location === 'undefined') return false;
    var ua = navigator.userAgent;
    return /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua) && location.protocol === 'https:';
  }

  function permissionState() {
    if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return Promise.resolve(null);
    var names = ['loopback-network', 'local-network-access', 'local-network'];
    var i = 0;
    function tryNext() {
      if (i >= names.length) return Promise.resolve(null);
      var name = names[i++];
      return navigator.permissions.query({ name: name }).then(function (s) { return s.state; }, tryNext);
    }
    return tryNext();
  }

  // ---------------------------------------------------------------------------
  // Cliente
  // ---------------------------------------------------------------------------
  function Client(options) {
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.status = 'connecting';
    this.agent = null;
    this.port = null;
    this._ws = null;
    this._seq = 0;
    this._pending = {};
    this._listeners = {};
    this._closed = false;
    this._retry = 0;
    this._connect();
  }

  Client.prototype._log = function () {
    if (this.options.debug && typeof console !== 'undefined') console.log.apply(console, ['[EasyPrint]'].concat([].slice.call(arguments)));
  };

  Client.prototype.on = function (event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    if (event === 'status') fn(this.status, this.diagnose());
    var self = this;
    return function off() { self._listeners[event] = (self._listeners[event] || []).filter(function (f) { return f !== fn; }); };
  };

  Client.prototype._emit = function (event, a, b) {
    (this._listeners[event] || []).forEach(function (fn) { try { fn(a, b); } catch (e) { setTimeout(function () { throw e; }); } });
  };

  Client.prototype._setStatus = function (s) {
    if (this.status === s) return;
    this._log('status:', s);
    this.status = s;
    this._emit('status', s, this.diagnose());
    if (s === 'ready') this._emit('ready');
  };

  Client.prototype._connect = function () {
    var self = this;
    if (this._closed) return;
    if (isSafariHttps()) { this._setStatus('unsupported_browser'); return; }
    var ports = this.options.ports.slice();
    if (this.port) ports.unshift(this.port); // tenta primeiro a última porta que funcionou
    ports = ports.filter(function (p, i) { return ports.indexOf(p) === i; });

    (function attempt(i) {
      if (self._closed) return;
      if (i >= ports.length) return self._unreachable();
      var url = 'ws://' + self.options.host + ':' + ports[i] + '/ws';
      var ws, settled = false;
      try { ws = new WebSocket(url); } catch (e) { return attempt(i + 1); }
      var timer = setTimeout(function () { if (!settled) { settled = true; try { ws.close(); } catch (e) { /* ignora */ } attempt(i + 1); } }, 2500);
      ws.onopen = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        self._ws = ws; self.port = ports[i]; self._retry = 0;
        self._bind(ws);
        self._hello();
      };
      ws.onerror = function () { if (!settled) { settled = true; clearTimeout(timer); attempt(i + 1); } };
      ws.onclose = function () { if (!settled) { settled = true; clearTimeout(timer); attempt(i + 1); } };
    })(0);
  };

  Client.prototype._unreachable = function () {
    var self = this;
    permissionState().then(function (state) {
      self._setStatus(state === 'denied' ? 'browser_blocked' : 'not_running');
      self._scheduleReconnect();
    });
  };

  Client.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._closed || !this.options.autoReconnect) return;
    var delay = Math.min(10000, 2000 + this._retry++ * 1000);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(function () { self._connect(); }, delay);
  };

  Client.prototype._bind = function (ws) {
    var self = this;
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.event === 'authorization') { self._setStatus(msg.data.state); return; }
      if (msg.event) { self._emit(msg.event, msg.data); return; }
      var p = self._pending[msg.id];
      if (!p) return;
      delete self._pending[msg.id];
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(EasyPrintError(msg.error.code, msg.error.message, msg.error.hint));
    };
    ws.onclose = function () {
      self._ws = null;
      Object.keys(self._pending).forEach(function (id) {
        var p = self._pending[id]; clearTimeout(p.timer);
        p.reject(EasyPrintError('DISCONNECTED', 'A conexão com o EasyPrint caiu durante a operação.', 'Verifique se o EasyPrint continua aberto e tente de novo.'));
      });
      self._pending = {};
      clearInterval(self._ping);
      if (!self._closed) { self._setStatus('disconnected'); self._scheduleReconnect(); }
    };
    clearInterval(this._ping);
    this._ping = setInterval(function () { self._call('ping').catch(function () {}); }, 30000);
  };

  Client.prototype._hello = function () {
    var self = this;
    this._call('hello', { appName: this.options.appName, token: this.options.token, routes: this.options.routes, sdkVersion: VERSION }).then(function (r) {
      self.agent = r.agent;
      self._setStatus(r.state);
    }, function (e) {
      self._log('hello falhou', e);
      self.lastError = e;
      self._setStatus(e.code === 'INVALID_TOKEN' ? 'denied' : 'not_running');
    });
  };

  Client.prototype._call = function (method, params, timeout) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self._ws || self._ws.readyState !== 1) return reject(EasyPrintError('NOT_RUNNING', MESSAGES.not_running.title, MESSAGES.not_running.steps.join(' ')));
      var id = ++self._seq;
      var timer = setTimeout(function () {
        delete self._pending[id];
        reject(EasyPrintError('TIMEOUT', 'O EasyPrint demorou demais para responder.', 'Verifique se a impressora está ligada e tente novamente.'));
      }, timeout || self.options.requestTimeout);
      self._pending[id] = { resolve: resolve, reject: reject, timer: timer };
      self._ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  };

  /** Espera ficar pronto. Rejeita com erro explicativo se não for possível. */
  Client.prototype.ready = function (timeoutMs) {
    var self = this;
    if (this.status === 'ready') return Promise.resolve(this);
    var limit = timeoutMs || (this.status === 'awaiting_approval' ? 120000 : 8000);
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function (ok) {
        if (done) return; done = true; clearTimeout(timer); off();
        if (ok) return resolve(self);
        var d = self.diagnose();
        var code = { not_running: 'NOT_RUNNING', browser_blocked: 'BROWSER_BLOCKED', awaiting_approval: 'NOT_AUTHORIZED', denied: 'DENIED', unsupported_browser: 'UNSUPPORTED_BROWSER' }[self.status] || 'NOT_RUNNING';
        reject(EasyPrintError(code, d.title, d.steps.join(' ')));
      };
      var off = self.on('status', function (s) {
        if (s === 'ready') finish(true);
        else if (s === 'denied' || s === 'unsupported_browser') finish(false);
        else if (s === 'awaiting_approval') { clearTimeout(timer); timer = setTimeout(function () { finish(false); }, 120000); }
      });
      var timer = setTimeout(function () { finish(false); }, limit);
    });
  };

  /** Lista as impressoras disponíveis. */
  Client.prototype.printers = function () {
    var self = this;
    return this.ready().then(function () { return self._call('printers.list'); });
  };

  /** Impressora padrão escolhida no EasyPrint. */
  Client.prototype.defaultPrinter = function () {
    var self = this;
    return this.ready().then(function () { return self._call('printers.default'); });
  };

  /**
   * Imprime. Aceita:
   *  - um builder: EasyPrint.receipt()...
   *  - um documento: { blocks: [...] } ou [...]
   *  - { raw }, { text } ou { image } (veja printRaw/printText/printImage)
   * opções: { printer, copies, jobName }
   */
  Client.prototype.print = function (what, opts) {
    var self = this;
    opts = opts || {};
    var req = { printer: opts.printer, route: opts.route, copies: opts.copies, jobName: opts.jobName, options: opts.options };
    if (what && typeof what.build === 'function') req.document = what.build();
    else if (Array.isArray(what) || (what && what.blocks)) req.document = what;
    else if (what && (what.raw !== undefined || what.text !== undefined || what.image !== undefined || what.pdf !== undefined || what.html !== undefined)) {
      if (what.raw !== undefined) req.raw = typeof what.raw === 'object' && !ArrayBuffer.isView(what.raw) && !(what.raw instanceof ArrayBuffer) && !Array.isArray(what.raw) ? what.raw : rawToBase64(what.raw);
      if (what.text !== undefined) req.text = String(what.text);
      if (what.image !== undefined) req.image = what.image;
      if (what.pdf !== undefined) { req.pdf = what.pdf; req.pdfOptions = what.pdfOptions; }
      if (what.html !== undefined) { req.html = what.html; req.htmlOptions = what.htmlOptions; }
    } else if (typeof what === 'string') req.text = what;
    else return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'Nada para imprimir.', 'Passe EasyPrint.receipt()..., um documento { blocks } ou um texto.'));
    return this.ready().then(function () { return self._call('print', req); });
  };

  /** Envia bytes direto para a impressora (ESC/POS, ZPL, EPL, PCL…). */
  Client.prototype.printRaw = function (data, opts) { return this.print({ raw: data }, opts); };
  /** Imprime texto simples. */
  Client.prototype.printText = function (text, opts) { return this.print({ text: text }, opts); };
  /** Imprime uma imagem (URL, data URL, <img> ou <canvas>). */
  Client.prototype.printImage = function (src, opts) {
    var self = this;
    return toPngDataUrl(src, opts && opts.maxWidth).then(function (png) { return self.print({ image: png }, opts); });
  };

  /**
   * Imprime um PDF (DANFE, etiqueta de marketplace, boleto, relatório…).
   * source: URL (baixada pelo navegador, com os cookies do seu site), data URL, Blob, ArrayBuffer ou Uint8Array.
   * opts: { printer, route, copies, jobName, pages: '1-3', fit: 'page'|'actual', paperSize: 'A4'|'A5'|'Letter'|'auto' }
   */
  Client.prototype.printPdf = function (source, opts) {
    var self = this;
    opts = opts || {};
    return pdfToBase64(source).then(function (b64) {
      return self.print({ pdf: b64, pdfOptions: { pages: opts.pages, fit: opts.fit, paperSize: opts.paperSize, dpi: opts.dpi } }, opts);
    });
  };

  /**
   * Imprime HTML (layouts prontos do seu sistema: comanda, DANFE em HTML, relatório…).
   * html: string com o HTML ou um elemento da página (os estilos da página são incluídos).
   * opts: { printer, route, copies, jobName, paperSize, javascript: false }
   * O EasyPrint renderiza num navegador isolado: JavaScript fica desligado, a menos que javascript: true.
   */
  Client.prototype.printHtml = function (html, opts) {
    opts = opts || {};
    var content = html;
    if (typeof Element !== 'undefined' && html instanceof Element) {
      var styles = Array.prototype.map.call(document.querySelectorAll('style, link[rel="stylesheet"]'), function (n) {
        if (n.tagName === 'LINK') return '<link rel="stylesheet" href="' + n.href.replace(/"/g, '&quot;') + '">';
        return n.outerHTML;
      }).join('');
      content = '<!doctype html><html><head>' + styles + '</head><body>' + html.outerHTML + '</body></html>';
    }
    if (typeof content !== 'string' || !content.trim()) return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'O HTML está vazio.'));
    var baseUrl = opts.baseUrl || (typeof location !== 'undefined' && /^https?:/.test(location.href) ? location.href : undefined);
    return this.print({ html: content, htmlOptions: { baseUrl: baseUrl, javascript: opts.javascript === true, paperSize: opts.paperSize } }, opts);
  };

  /** Finalidades configuradas pelo lojista: [{ route, label, printer }] */
  Client.prototype.routes = function () {
    var self = this;
    return this.ready().then(function () { return self._call('routes.list'); });
  };

  /** Explica o status atual em linguagem simples, com passos para resolver. */
  Client.prototype.diagnose = function () {
    var m = MESSAGES[this.status] || MESSAGES.not_running;
    var steps = m.steps.slice();
    if (this.status === 'not_running' && this.options.downloadUrl) steps[2] = 'Ainda não instalou? Baixe em: ' + this.options.downloadUrl;
    if (this.status === 'denied' && this.lastError && this.lastError.code === 'INVALID_TOKEN') {
      return { ok: false, status: this.status, title: 'Token inválido', message: this.lastError.message, steps: [this.lastError.hint] };
    }
    return { ok: this.status === 'ready', status: this.status, title: m.title, message: m.message, steps: steps, downloadUrl: this.options.downloadUrl };
  };

  /** Encerra a conexão. */
  Client.prototype.disconnect = function () {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._ping);
    if (this._ws) this._ws.close();
  };

  // ---------------------------------------------------------------------------
  // Construtor de cupons / recibos (documento universal)
  // ---------------------------------------------------------------------------
  function Receipt() { this.blocks = []; }
  Receipt.prototype._add = function (b) { this.blocks.push(b); return this; };
  /** Texto. opts: { align:'left'|'center'|'right', bold, size:1|2|3, underline, invert } */
  Receipt.prototype.text = function (value, opts) { return this._add(Object.assign({ type: 'text', value: String(value) }, opts)); };
  Receipt.prototype.center = function (value, opts) { return this.text(value, Object.assign({ align: 'center' }, opts)); };
  Receipt.prototype.bold = function (value, opts) { return this.text(value, Object.assign({ bold: true }, opts)); };
  /** Título grande, centralizado e em negrito. */
  Receipt.prototype.title = function (value) { return this._add({ type: 'title', value: String(value) }); };
  /** Linha separadora. */
  Receipt.prototype.line = function (char) { return this._add({ type: 'line', char: char }); };
  /** Duas colunas: texto à esquerda e valor à direita. */
  Receipt.prototype.row = function (left, right, opts) { return this._add(Object.assign({ type: 'row', left: left, right: right }, opts)); };
  /** Item de pedido: "2x X-Burguer ...... R$ 30,00" + observação. */
  Receipt.prototype.item = function (qty, name, price, note) { return this._add({ type: 'item', qty: qty, name: name, price: price, note: note }); };
  /** Total em destaque. */
  Receipt.prototype.total = function (label, value) { return this._add({ type: 'total', label: label, value: value }); };
  Receipt.prototype.qr = function (value, size) { return this._add({ type: 'qr', value: String(value), size: size }); };
  Receipt.prototype.barcode = function (value, format) { return this._add({ type: 'barcode', value: String(value), format: format || 'CODE128' }); };
  /** Imagem PNG em data URL (use: await EasyPrint.image('logo.png')). */
  Receipt.prototype.image = function (src, opts) { return this._add(Object.assign({ type: 'image', src: src }, opts)); };
  Receipt.prototype.feed = function (lines) { return this._add({ type: 'feed', lines: lines || 1 }); };
  Receipt.prototype.cut = function () { return this._add({ type: 'cut' }); };
  /** Abre a gaveta de dinheiro conectada à impressora. */
  Receipt.prototype.drawer = function () { return this._add({ type: 'drawer' }); };
  Receipt.prototype.build = function () { return { blocks: this.blocks.slice() }; };

  var MAX_PDF = 25 * 1024 * 1024;
  function pdfToBase64(source) {
    function fromBuffer(buf) {
      var bytes = new Uint8Array(buf);
      if (bytes.length > MAX_PDF) throw EasyPrintError('TOO_LARGE', 'O PDF é grande demais (limite de 25 MB).', 'Imprima menos páginas ou reduza o arquivo.');
      return toBase64(bytes);
    }
    try {
      if (typeof source === 'string') {
        if (/^data:application\/pdf;base64,/i.test(source)) return Promise.resolve(source.split(',')[1]);
        return fetch(source, { credentials: 'include' }).then(function (r) {
          if (!r.ok) throw EasyPrintError('INVALID_DOCUMENT', 'Não foi possível baixar o PDF (HTTP ' + r.status + ').', 'Confira a URL e se o usuário tem acesso ao arquivo.');
          return r.arrayBuffer();
        }, function () {
          throw EasyPrintError('INVALID_DOCUMENT', 'Não foi possível baixar o PDF.', 'Se o PDF estiver em outro domínio, ele precisa liberar CORS — ou baixe no seu servidor e envie os bytes.');
        }).then(fromBuffer);
      }
      if (typeof Blob !== 'undefined' && source instanceof Blob) return source.arrayBuffer().then(fromBuffer);
      if (source instanceof ArrayBuffer) return Promise.resolve(fromBuffer(source));
      if (ArrayBuffer.isView(source)) return Promise.resolve(fromBuffer(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)));
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'Formato de PDF não suportado.', 'Use URL, Blob, ArrayBuffer ou Uint8Array.'));
  }

  // ---------------------------------------------------------------------------
  // Imagens -> PNG data URL (o formato que o agente entende)
  // ---------------------------------------------------------------------------
  function toPngDataUrl(src, maxWidth) {
    maxWidth = maxWidth || 576;
    if (typeof document === 'undefined') {
      if (typeof src === 'string' && /^data:image\/png;base64,/.test(src)) return Promise.resolve(src);
      return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'Fora do navegador, envie a imagem já como PNG em data URL.'));
    }
    return new Promise(function (resolve, reject) {
      function draw(img) {
        var w = img.naturalWidth || img.width, hgt = img.naturalHeight || img.height;
        var scale = Math.min(1, maxWidth / w);
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(hgt * scale));
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/png')); }
        catch (e) { reject(EasyPrintError('INVALID_DOCUMENT', 'Não foi possível ler a imagem (bloqueio de CORS).', 'Hospede a imagem no mesmo domínio do site ou habilite CORS nela.')); }
      }
      if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) return draw(src);
      if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement && src.complete) return draw(src);
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { draw(img); };
      img.onerror = function () { reject(EasyPrintError('INVALID_DOCUMENT', 'Não foi possível carregar a imagem.', 'Confira o endereço da imagem.')); };
      img.src = typeof src === 'string' ? src : src.src;
    });
  }

  // ---------------------------------------------------------------------------
  // Widget de status pronto (opcional) — mostra o estado e como resolver
  // ---------------------------------------------------------------------------
  function widget(client, container, opts) {
    opts = opts || {};
    if (typeof document === 'undefined') return function () {};
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) throw new Error('EasyPrint.widget: elemento não encontrado.');
    var rootEl = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var COLORS = { ready: '#16a34a', connecting: '#64748b', disconnected: '#f59e0b', awaiting_approval: '#f59e0b', not_running: '#dc2626', browser_blocked: '#dc2626', denied: '#dc2626', unsupported_browser: '#dc2626' };
    var style = '<style>' +
      ':host{all:initial;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:inherit}' +
      '.w{display:inline-block;position:relative}' +
      '.b{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font:inherit;cursor:pointer}' +
      '.d{width:9px;height:9px;border-radius:50%}' +
      '.p{position:absolute;z-index:9999;top:calc(100% + 8px);' + (opts.align === 'right' ? 'right:0' : 'left:0') + ';width:320px;max-width:90vw;background:#fff;color:#16191d;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.2);padding:16px}' +
      '.p h4{margin:0 0 6px;font-size:15px}.p p{margin:0 0 8px;color:#5d6670}.p ol{margin:0;padding-left:20px}.p li{margin:4px 0}' +
      '.x{margin-top:12px;display:flex;gap:8px}.x button{padding:6px 12px;border-radius:8px;border:1px solid #d0d5da;background:#fff;cursor:pointer;font:inherit}' +
      '</style>';
    var open = false;
    function render() {
      var d = client.diagnose();
      var label = d.ok ? (opts.readyLabel || 'Impressora pronta') : d.title;
      var html = style + '<div class="w"><button class="b" part="button"><span class="d" style="background:' + (COLORS[d.status] || '#64748b') + '"></span>' + esc(label) + '</button>';
      if (open && !d.ok) {
        html += '<div class="p" role="dialog"><h4>' + esc(d.title) + '</h4><p>' + esc(d.message) + '</p>' +
          (d.steps.length ? '<ol>' + d.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '') +
          '<div class="x"><button data-a="retry">Tentar de novo</button>' + (d.downloadUrl && d.status === 'not_running' ? '<button data-a="dl">Baixar EasyPrint</button>' : '') + '</div></div>';
      }
      html += '</div>';
      rootEl.innerHTML = html;
      rootEl.querySelector('.b').onclick = function () { open = !open; render(); };
      var r = rootEl.querySelector('[data-a=retry]'); if (r) r.onclick = function () { open = false; client._retry = 0; client._connect(); render(); };
      var dl = rootEl.querySelector('[data-a=dl]'); if (dl) dl.onclick = function () { window.open(d.downloadUrl, '_blank', 'noopener'); };
    }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    return client.on('status', function () { if (client.status === 'ready') open = false; render(); });
  }

  // ---------------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------------
  var shared = null;
  return {
    VERSION: VERSION,
    /** Conecta ao EasyPrint. Chame uma vez e reutilize o cliente. */
    connect: function (options) {
      if (!options || !options.fresh) {
        if (shared && !shared._closed) return shared;
        shared = new Client(options);
        return shared;
      }
      return new Client(options);
    },
    /** Novo cupom/recibo (builder encadeável). */
    receipt: function () { return new Receipt(); },
    /** Converte imagem (URL, <img>, <canvas>) para PNG data URL. */
    image: toPngDataUrl,
    /** Widget de status com instruções de correção. */
    widget: widget,
    messages: MESSAGES,
    Error: EasyPrintError,
  };
});

```


# Anexo B — easyprint.d.ts

```ts
// Tipos do SDK EasyPrint v1.0.0

export type EasyPrintStatus =
  | 'connecting'
  | 'ready'
  | 'not_running'
  | 'browser_blocked'
  | 'awaiting_approval'
  | 'denied'
  | 'unsupported_browser'
  | 'disconnected';

export type EasyPrintErrorCode =
  | 'NOT_RUNNING' | 'BROWSER_BLOCKED' | 'NOT_AUTHORIZED' | 'DENIED' | 'UNSUPPORTED_BROWSER'
  | 'PRINTER_NOT_FOUND' | 'NO_DEFAULT_PRINTER' | 'PRINT_FAILED' | 'INVALID_DOCUMENT'
  | 'INVALID_TOKEN' | 'ORIGIN_REQUIRED' | 'TIMEOUT' | 'DISCONNECTED' | 'INTERNAL'
  | 'TOO_LARGE' | 'UNSUPPORTED' | 'INVALID_ROUTE' | 'POLICY_BLOCKED';

export interface EasyPrintError extends Error {
  name: 'EasyPrintError';
  code: EasyPrintErrorCode;
  /** Como resolver, em linguagem simples (pt-BR). Mostre ao usuário. */
  hint: string | null;
}

export interface ConnectOptions {
  /** Nome do seu sistema — aparece na janela de permissão do EasyPrint. */
  appName?: string;
  /** Padrão: '127.0.0.1' */
  host?: string;
  /** Padrão: [17777, 17778, 17779] */
  ports?: number[];
  /** Token de "App local" (apenas para apps sem navegador / file://). */
  token?: string;
  /** Reconecta sozinho se o EasyPrint fechar/abrir. Padrão: true */
  autoReconnect?: boolean;
  /**
   * Finalidades que o seu sistema usa, com o nome que o lojista vai ver no painel.
   * O lojista escolhe a impressora de cada uma (ex.: etiqueta → Zebra, danfe → Laser).
   * Ex.: { pedido: 'Pedidos (cozinha)', etiqueta: 'Etiquetas de envio', danfe: 'Notas fiscais (DANFE)' }
   */
  routes?: Record<string, string>;
  /** Link de download do EasyPrint mostrado quando ele não está instalado. */
  downloadUrl?: string;
  /** Timeout de cada operação em ms. Padrão: 60000 */
  requestTimeout?: number;
  /** Cria um cliente novo em vez de reutilizar o compartilhado. */
  fresh?: boolean;
  debug?: boolean;
}

export interface Diagnosis {
  ok: boolean;
  status: EasyPrintStatus;
  title: string;
  message: string;
  /** Passos para o usuário resolver. */
  steps: string[];
  downloadUrl?: string | null;
}

export interface PrinterInfo {
  name: string;
  kind: 'thermal' | 'label' | 'office' | 'system' | 'virtual';
  online: boolean;
  isDefault: boolean;
  mode: 'escpos' | 'zpl' | 'office' | 'virtual';
  paperWidth?: 58 | 80;
  labelWidth?: number;
  labelHeight?: number | null;
  dpi?: 203 | 300;
  paperSize?: string;
  /** Caracteres por linha. */
  columns: number;
}

export interface PrintOptions {
  /** Nome (ou parte do nome) da impressora. Tem prioridade sobre `route`. */
  printer?: string;
  /** Finalidade (ex.: 'etiqueta', 'danfe', 'cozinha'). O lojista escolhe a impressora no painel; sem configuração usa a padrão. */
  route?: string;
  copies?: number;
  /** Nome do trabalho na fila do sistema. */
  jobName?: string;
  /** Sobrescreve o perfil da impressora só nesta impressão. */
  options?: Partial<{ paperWidth: 58 | 80; codepage: 'cp860' | 'cp850' | 'cp1252' | 'ascii'; columns: number; autoCut: boolean; labelWidth: number; labelHeight: number; dpi: 203 | 300; paperSize: string }>;
}

export interface PrintResult {
  jobId: string;
  printer: string;
  mode: string;
  status: 'done';
  /** Como a impressora foi escolhida. 'default-fallback' = a finalidade ainda não foi configurada pelo lojista. */
  routedBy: 'printer' | 'route' | 'default' | 'default-fallback';
  /** Páginas impressas (PDF). */
  pages?: number;
}

export interface PdfOptions extends PrintOptions {
  /** Páginas, ex.: '1', '1-3,5'. Padrão: todas. */
  pages?: string;
  /** 'page' (padrão) ajusta à folha; 'actual' mantém o tamanho real. */
  fit?: 'page' | 'actual';
  /** Papel em impressoras comuns: 'A4', 'A5', 'Letter'… Padrão: o do perfil ('auto'). */
  paperSize?: string;
  /** Resolução de renderização em impressoras comuns (72–600). Padrão 200. */
  dpi?: number;
}

export interface RouteInfo { route: string; label: string; printer: string | null; }

export type Align = 'left' | 'center' | 'right';

export type Block =
  | string
  | { type: 'text'; value: string; align?: Align; bold?: boolean; size?: 1 | 2 | 3; underline?: boolean; invert?: boolean }
  | { type: 'title'; value: string }
  | { type: 'line'; char?: string }
  | { type: 'row'; left: string; right: string; bold?: boolean; size?: 1 | 2 | 3 }
  | { type: 'item'; qty?: number | string; name: string; price?: string; note?: string; bold?: boolean }
  | { type: 'total'; label?: string; value: string }
  | { type: 'qr'; value: string; size?: number; align?: Align }
  | { type: 'barcode'; value: string; format?: 'CODE128' | 'EAN13'; align?: Align }
  | { type: 'image'; src: string; align?: Align; width?: number }
  | { type: 'feed'; lines?: number }
  | { type: 'cut' }
  | { type: 'drawer' };

export interface PrintDocument { blocks: Block[]; }

export interface ReceiptBuilder {
  text(value: string, opts?: { align?: Align; bold?: boolean; size?: 1 | 2 | 3; underline?: boolean; invert?: boolean }): this;
  center(value: string, opts?: { bold?: boolean; size?: 1 | 2 | 3 }): this;
  bold(value: string, opts?: { align?: Align; size?: 1 | 2 | 3 }): this;
  title(value: string): this;
  line(char?: string): this;
  row(left: string, right: string, opts?: { bold?: boolean; size?: 1 | 2 | 3 }): this;
  item(qty: number | string | null, name: string, price?: string, note?: string): this;
  total(label: string, value: string): this;
  qr(value: string, size?: number): this;
  barcode(value: string, format?: 'CODE128' | 'EAN13'): this;
  /** src = PNG em data URL. Use `await EasyPrint.image(url)`. */
  image(src: string, opts?: { align?: Align; width?: number }): this;
  feed(lines?: number): this;
  cut(): this;
  drawer(): this;
  build(): PrintDocument;
}

export type RawData = string | Uint8Array | ArrayBuffer | Array<string | number | Uint8Array> | { hex: string } | { base64: string } | { text: string };

export interface EasyPrintClient {
  readonly status: EasyPrintStatus;
  readonly port: number | null;
  readonly agent: { name: string; version: string } | null;
  /** Escuta mudanças de status. Chama imediatamente com o status atual. Retorna função para cancelar. */
  on(event: 'status', fn: (status: EasyPrintStatus, diagnosis: Diagnosis) => void): () => void;
  on(event: 'ready', fn: () => void): () => void;
  /** Resolve quando pronto; rejeita com EasyPrintError explicativo. */
  ready(timeoutMs?: number): Promise<EasyPrintClient>;
  printers(): Promise<PrinterInfo[]>;
  defaultPrinter(): Promise<PrinterInfo | null>;
  print(what: ReceiptBuilder | PrintDocument | Block[] | string | { raw: RawData } | { text: string } | { image: string } | { pdf: string; pdfOptions?: Omit<PdfOptions, keyof PrintOptions> }, opts?: PrintOptions): Promise<PrintResult>;
  printRaw(data: RawData, opts?: PrintOptions): Promise<PrintResult>;
  /** Imprime PDF: URL (baixada com os cookies do site), data URL, Blob, ArrayBuffer ou Uint8Array. Até 25 MB. */
  printPdf(source: string | Blob | ArrayBuffer | Uint8Array, opts?: PdfOptions): Promise<PrintResult>;
  /**
   * Imprime HTML (string ou elemento da página, com os estilos da página). Renderizado num navegador
   * isolado; JavaScript desligado por padrão. Funciona em impressora comum, térmica e etiqueta.
   */
  printHtml(html: string | Element, opts?: PrintOptions & { paperSize?: string; javascript?: boolean; baseUrl?: string }): Promise<PrintResult>;
  /** Finalidades e as impressoras escolhidas pelo lojista. */
  routes(): Promise<RouteInfo[]>;
  printText(text: string, opts?: PrintOptions): Promise<PrintResult>;
  printImage(src: string | HTMLImageElement | HTMLCanvasElement, opts?: PrintOptions & { maxWidth?: number }): Promise<PrintResult>;
  /** Explica o status atual com passos de correção (pt-BR). */
  diagnose(): Diagnosis;
  disconnect(): void;
}

export interface EasyPrintStatic {
  VERSION: string;
  connect(options?: ConnectOptions): EasyPrintClient;
  receipt(): ReceiptBuilder;
  image(src: string | HTMLImageElement | HTMLCanvasElement, maxWidth?: number): Promise<string>;
  widget(client: EasyPrintClient, container: string | Element, opts?: { align?: 'left' | 'right'; readyLabel?: string }): () => void;
  messages: Record<EasyPrintStatus, { title: string; message: string; steps: string[] }>;
}

declare const EasyPrint: EasyPrintStatic;
export default EasyPrint;
export declare const connect: EasyPrintStatic['connect'];
export declare const receipt: EasyPrintStatic['receipt'];
export declare const image: EasyPrintStatic['image'];
export declare const widget: EasyPrintStatic['widget'];
export declare const messages: EasyPrintStatic['messages'];
export declare const VERSION: string;

declare global {
  interface Window { EasyPrint: EasyPrintStatic; }
}

```


# Anexo C — easyprint-cloud.js (SDK de servidor, só para impressão pela nuvem)

```js
'use strict';
/*!
 * EasyPrint Cloud — SDK de servidor (Node 18+). Sem dependências. Protocolo v2.
 * Use no back-end do seu ERP / loja virtual para mandar impressões para os computadores das lojas.
 *
 *   const { EasyPrintCloud, generateKeys } = require('./easyprint-cloud');
 *   const keys = generateKeys();                 // 1x — guarde a privada em segredo (cofre / env)
 *   const cloud = new EasyPrintCloud({ relayUrl, apiKey, privateKey: keys.privateKey, publicKey: keys.publicKey });
 *
 *   // 1x por loja: guarde { deviceId, deviceSecret } no seu banco (deviceSecret é SEGREDO) e mostre o código ao lojista
 *   const { deviceId, deviceSecret, connectionCode } = await cloud.createDevice('Loja Centro');
 *
 *   // depois que o lojista colar o código no EasyPrint:
 *   await cloud.print({ deviceId, deviceSecret }, { route: 'etiqueta', raw: { text: zpl } });
 *
 * Segurança:
 *  - Cada trabalho é ASSINADO (Ed25519, sua chave) e CIFRADO de ponta a ponta (X25519 + AES-256-GCM)
 *    para a chave gerada no computador da loja. O relay só vê bytes cifrados.
 *  - A chave da loja é autenticada com o deviceSecret (que nunca passa pelo relay): se o relay tentar
 *    trocar a chave para ler os pedidos, print() recusa com KEY_MISMATCH.
 */
const crypto = require('crypto');

const KEY_MAC_LABEL = 'easyprint-device-key-v2';
const HKDF_INFO = 'easyprint-job-v2';

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const fingerprint = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16).match(/.{4}/g).join(' ');

function toBase64(data) {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data.replace(/^data:[^,]*,/, '');
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64');
  throw new TypeError('Use string base64, Buffer, Uint8Array ou ArrayBuffer.');
}

function keyMac(deviceSecret, deviceId, encryptionKey) {
  return crypto.createHmac('sha256', Buffer.from(deviceSecret, 'base64url')).update(`${KEY_MAC_LABEL}:${deviceId}:${encryptionKey}`).digest('hex');
}

function connectionCode({ relayUrl, pairToken, deviceSecret, deviceId, name, publicKey }) {
  const json = JSON.stringify({ v: 2, url: relayUrl.replace(/\/+$/, ''), pairToken, pairSecret: deviceSecret, deviceId, name, publicKey });
  return 'EPC2.' + Buffer.from(json, 'utf8').toString('base64url');
}

function encryptFor(encryptionKey, { id, deviceId }, plainObj) {
  const devicePub = crypto.createPublicKey({ key: Buffer.from(encryptionKey, 'base64'), format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: devicePub });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, epk, `${HKDF_INFO}:${id}`, 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${id}:${deviceId}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()]);
  return { alg: 'X25519-HKDF-SHA256-A256GCM', epk: epk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Monta, cifra e assina um trabalho. Útil se você implementar o relay no seu próprio back-end. */
function signJob({ deviceId, encryptionKey, job, privateKey, ttlMs = 24 * 3600 * 1000 }) {
  if (!deviceId) throw new Error('deviceId é obrigatório');
  if (!encryptionKey) throw new Error('encryptionKey (chave do computador da loja) é obrigatória');
  if (ttlMs > 7 * 24 * 3600 * 1000) throw new Error('A validade máxima é 7 dias');
  const key = typeof privateKey === 'string'
    ? crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    : privateKey;
  const ts = Date.now();
  const id = crypto.randomUUID();
  const inner = {
    printer: job.printer, route: job.route, copies: job.copies, jobName: job.jobName, options: job.options,
    document: job.document && typeof job.document.build === 'function' ? job.document.build() : job.document,
    text: job.text, image: job.image,
    raw: job.raw === undefined ? undefined : (job.raw && typeof job.raw === 'object' && !Buffer.isBuffer(job.raw) && !(job.raw instanceof Uint8Array) ? job.raw : toBase64(job.raw)),
    pdf: toBase64(job.pdf), pdfOptions: job.pdfOptions, html: job.html, htmlOptions: job.htmlOptions,
  };
  const outer = { v: 2, id, deviceId: String(deviceId), ts, expiresAt: ts + ttlMs };
  outer.enc = encryptFor(encryptionKey, outer, inner);
  const payload = JSON.stringify(outer);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
  return { id, payload, signature };
}

class EasyPrintCloud {
  /**
   * @param {object} o
   * @param {string} o.relayUrl   URL do relay (https)
   * @param {string} o.apiKey     chave da API do relay (segredo do servidor)
   * @param {string} o.privateKey chave privada Ed25519 (base64 PKCS8) — NUNCA envie ao navegador
   * @param {string} o.publicKey  chave pública Ed25519 (base64 SPKI) — vai no código de conexão
   */
  constructor({ relayUrl, apiKey, privateKey, publicKey }) {
    if (!relayUrl || !apiKey || !privateKey || !publicKey) throw new Error('relayUrl, apiKey, privateKey e publicKey são obrigatórios');
    this.relayUrl = relayUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.privateKey = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    this.publicKey = publicKey;
    this.keys = new Map(); // deviceId -> encryptionKey já verificada
  }

  async _req(method, path, body) {
    const res = await fetch(this.relayUrl + path, {
      method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error((data && data.error && data.error.message) || `Relay respondeu ${res.status}`);
      e.status = res.status; e.code = data && data.error && data.error.code;
      throw e;
    }
    return data;
  }

  /**
   * Cria um computador/loja. Guarde deviceId e deviceSecret (segredo!) no seu banco e mostre o
   * connectionCode para o lojista colar no EasyPrint (Nuvem → Conectar). O código é de uso único.
   */
  async createDevice(name) {
    const d = await this._req('POST', '/v1/devices', { name });
    const deviceSecret = crypto.randomBytes(32).toString('base64url');
    return {
      deviceId: d.deviceId,
      deviceSecret,
      connectionCode: connectionCode({ relayUrl: this.relayUrl, pairToken: d.pairToken, deviceSecret, deviceId: d.deviceId, name, publicKey: this.publicKey }),
    };
  }

  /** Status: { online, paired, lastSeen, agent, printers, routes, encryptionFingerprint } */
  async device(deviceId) {
    const d = await this._req('GET', `/v1/devices/${encodeURIComponent(deviceId)}`);
    return { ...d, encryptionFingerprint: d.encryptionKey ? fingerprint(d.encryptionKey) : null };
  }

  /** Revoga o acesso de um computador (o EasyPrint dele para de receber trabalhos). */
  revokeDevice(deviceId) { this.keys.delete(deviceId); return this._req('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`); }

  /** Busca a chave de criptografia da loja e confere que ela não foi trocada pelo relay. */
  async deviceKey({ deviceId, deviceSecret }) {
    if (this.keys.has(deviceId)) return this.keys.get(deviceId);
    if (!deviceSecret) throw Object.assign(new Error('deviceSecret é obrigatório (guardado ao criar o dispositivo).'), { code: 'MISSING_SECRET' });
    const d = await this._req('GET', `/v1/devices/${encodeURIComponent(deviceId)}`);
    if (!d.paired || !d.encryptionKey) throw Object.assign(new Error('Este computador ainda não colou o código de conexão no EasyPrint.'), { code: 'NOT_PAIRED' });
    const expected = keyMac(deviceSecret, deviceId, d.encryptionKey);
    const ok = typeof d.keyMac === 'string' && d.keyMac.length === expected.length && crypto.timingSafeEqual(Buffer.from(d.keyMac), Buffer.from(expected));
    if (!ok) throw Object.assign(new Error('A chave do computador não confere: possível adulteração no relay. Nada foi enviado.'), { code: 'KEY_MISMATCH' });
    this.keys.set(deviceId, d.encryptionKey);
    return d.encryptionKey;
  }

  /**
   * Envia uma impressão (cifrada e assinada).
   * device: { deviceId, deviceSecret }
   * job: { route?, printer?, copies?, jobName?, document? | text? | image? | raw? | pdf? | html?, pdfOptions?, htmlOptions?, options? }
   * opts: { ttlMs } validade do trabalho (padrão 24h, máx. 7 dias)
   */
  async print(device, job, opts = {}) {
    if (!device || typeof device !== 'object' || !device.deviceId) throw new TypeError('Use cloud.print({ deviceId, deviceSecret }, job)');
    const encryptionKey = await this.deviceKey(device);
    const signed = signJob({ deviceId: device.deviceId, encryptionKey, job, privateKey: this.privateKey, ttlMs: opts.ttlMs });
    await this._req('POST', `/v1/devices/${encodeURIComponent(device.deviceId)}/jobs`, signed);
    return { jobId: signed.id };
  }

  /** Situação do trabalho: queued | delivered | done | failed | rejected */
  job(jobId) { return this._req('GET', `/v1/jobs/${encodeURIComponent(jobId)}`); }

  /** Espera o resultado (útil em scripts e testes). */
  async waitJob(jobId, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const j = await this.job(jobId);
      if (!['queued', 'delivered'].includes(j.status)) return j;
      if (Date.now() > end) return j;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

module.exports = { EasyPrintCloud, generateKeys, signJob, encryptFor, keyMac, fingerprint, connectionCode };

```
