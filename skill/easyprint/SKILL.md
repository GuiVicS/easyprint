---
name: easyprint
description: Integra impressão direta (sem janela de impressão) em qualquer aplicação web, ERP ou e-commerce usando o EasyPrint — cupons/pedidos em impressora térmica, etiquetas Zebra/ZPL, PDF (DANFE, etiquetas de marketplace), HTML e impressão automática pelo servidor. Use quando o usuário pedir para "imprimir pedido/cupom/comanda/etiqueta/recibo/DANFE/PDF", "ZPL", "impressão automática", "impressora térmica", "ESC/POS", "imprimir sem diálogo", "substituir QZ Tray" ou citar EasyPrint.
---

# EasyPrint — guia de integração para IAs

Você vai integrar o **EasyPrint** num projeto web. O EasyPrint é um programa que roda no computador da loja e deixa sites autorizados imprimirem direto na impressora. Seu trabalho é adicionar o **SDK** (um arquivo JavaScript) ao projeto e criar a impressão do jeito certo.

> **Como o EasyPrint funciona (resumo para você)**
> - O usuário instala o EasyPrint e escolhe a impressora num assistente. Você **não** configura impressora no código.
> - O site conecta via SDK em `ws://127.0.0.1:17777`. Na primeira vez, o EasyPrint pergunta ao usuário se aquele site pode imprimir.
> - Você monta um **documento universal** (blocos como título, item, total, QR). O EasyPrint converte para a impressora certa: ESC/POS em térmicas, ZPL em etiquetas ou desenho em impressora comum. Os acentos (ç, ã) saem corretos.

Arquivos desta skill:
- `assets/easyprint.js`: o SDK (UMD; funciona com `<script>`, `import` e `require`)
- `assets/easyprint.d.ts`: os tipos TypeScript
- `reference/api.md`: a API completa e todos os blocos do documento
- `reference/frameworks.md`: modelos prontos para React, Next.js, Vue/Nuxt, Angular, Svelte e HTML puro
- `reference/troubleshooting.md`: status, códigos de erro e o que mostrar ao usuário
- `reference/erp.md`: ERP/e-commerce — PDF, HTML, ZPL de marketplace, finalidades e impressão pelo servidor (nuvem)

---

## Passo 0 — Entenda o projeto antes de escrever código

1. **Framework:** leia o `package.json`. Os sinais são `next`, `react`, `nuxt`, `vue`, `@angular/core` e `svelte`/`@sveltejs/kit`. Sem `package.json` (ou sem bundler), é HTML puro.
2. **TypeScript?** Procure `tsconfig.json`.
3. **O que imprimir:** encontre onde o pedido, a venda ou o recibo é exibido ou salvo. Anote os campos: número, itens (quantidade, nome, preço, observação), totais, cliente, endereço, pagamento.
4. **Impressão existente:** procure `window.print`, `qz-tray`, `qz.print`, `printJS` e `<iframe>` de impressão. Você vai substituir ou complementar isso.
5. Se algo essencial for ambíguo (por exemplo, quais dados vão no cupom), pergunte ao usuário. Se não for, siga os padrões abaixo.

## Passo 1 — Adicione o SDK ao projeto

Copie `assets/easyprint.js` e `assets/easyprint.d.ts` para o projeto:

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
- Em SSR (Next.js, Nuxt, SvelteKit, Angular Universal), só conecte no navegador. Veja `reference/frameworks.md`.
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
- ERP/e-commerce e impressão automática pelo servidor: siga `reference/erp.md`.

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

Os códigos e quando tratar de forma especial estão em `reference/troubleshooting.md`.

## Passo 6 (opcional) — Impressão automática de novos pedidos

Se o sistema recebe pedidos em tempo real (websocket, Supabase Realtime, polling):
- Imprima só quando `printer.status === 'ready'`. Se não estiver pronto, guarde numa fila e imprima no evento `printer.on('ready', ...)`.
- **Evite duplicar:** registre os IDs já impressos (no `localStorage` ou numa coluna `printed_at` no banco) antes de imprimir de novo.
- Dê ao usuário um botão para desligar a impressão automática.
- Se a impressão precisa acontecer **sem nenhuma tela aberta**, use a impressão pelo servidor (`reference/erp.md` → Impressão pelo servidor).

## Passo 7 — Verifique

1. Rode o projeto e abra a tela com impressão.
2. Com o EasyPrint aberto, clique em imprimir. Aprove o site na janela do EasyPrint e no navegador ("acessar apps neste dispositivo").
3. Sem impressora física: escolha **"EasyPrint Simulador"** no assistente e veja o resultado em **Painel → Histórico**.
4. Feche o EasyPrint e confira se a interface mostra "O EasyPrint não está aberto" com os passos.
5. Se o projeto tiver testes, troque o cliente por um mock (veja `reference/frameworks.md` → "Testes").

## Não faça

- ❌ Abrir `new WebSocket('ws://127.0.0.1:17777')` direto. Use o SDK, que já trata portas, reconexão, permissões e mensagens.
- ❌ Montar bytes ESC/POS na mão, a menos que o usuário peça um comando específico (use `printRaw` nesse caso).
- ❌ Chamar `connect()` a cada impressão ou em componentes que re-renderizam.
- ❌ Deixar o usuário sem resposta: todo `print()` precisa de `try/catch` com feedback.
- ❌ Esconder o erro do navegador "acesso à rede local". Mostre os `steps` do `diagnose()`.

Quando terminar, resuma para o usuário: os arquivos criados ou alterados, como testar (Simulador) e o que o lojista precisa fazer (instalar o EasyPrint, rodar o assistente e permitir o site).
