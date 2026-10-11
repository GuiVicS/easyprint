# ERP e e-commerce: receitas

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
3. **Para cada loja/computador:** crie um dispositivo e mostre o código para o lojista colar em EasyPrint → Nuvem.
   ```js
   const cloud = new EasyPrintCloud({ relayUrl: process.env.EP_RELAY_URL, apiKey: process.env.EP_RELAY_KEY, privateKey: process.env.EP_PRIVATE_KEY, publicKey: process.env.EP_PUBLIC_KEY });
   const { deviceId, connectionCode } = await cloud.createDevice('Loja Centro');
   // salve deviceId na loja; exiba connectionCode (EPC1....) na tela de configurações do ERP
   ```
4. **Imprima:**
   ```js
   await cloud.print(deviceId, { route: 'etiqueta', raw: { text: zpl } });
   await cloud.print(deviceId, { route: 'danfe', pdf: pdfBuffer, pdfOptions: { pages: '1' } });
   await cloud.print(deviceId, { route: 'pedido', document: { blocks: [...] }, copies: 2 });
   await cloud.print(deviceId, { route: 'pedido', html: '<h1>Pedido 9</h1>' });
   const status = await cloud.waitJob(jobId); // done | failed | rejected
   const online = (await cloud.device(deviceId)).online;
   ```
   O builder `EasyPrint.receipt()` também funciona no Node: `require('./easyprint.js').receipt()...build()`.

### Garantias de segurança
- **Assinatura Ed25519:** o EasyPrint só aceita trabalhos assinados pela chave pública fixada no código de conexão. Um relay invadido não consegue imprimir.
- **Amarrado ao computador:** o `deviceId` vai dentro do trabalho assinado e não pode ser reaproveitado em outra loja.
- **Validade:** 24 h por padrão, no máximo 7 dias. Trabalhos vencidos são recusados.
- **Anti-replay:** cada `id` só é impresso uma vez, mesmo após reiniciar o computador.
- **Políticas na loja:** "Abrir gaveta" vem desligado. "PDF/HTML" e "Comandos RAW" podem ser desligados pelo lojista.
- **Conexões só de saída, por HTTPS** (http apenas para `localhost` em desenvolvimento). O token do dispositivo é guardado com DPAPI no Windows e em arquivo `0600` no Linux.

### Protocolo do relay (para implementar no seu back-end)
Agente → relay (`Authorization: Bearer <token do dispositivo>`):
- `GET /v1/agent/jobs?wait=25` → `{ jobs: [{ id, payload, signature }] }`, com long-polling de até 30 s.
- `POST /v1/agent/jobs/:id/result` ← `{ status: 'done'|'failed'|'rejected'|'duplicate', error?, printer?, pages? }`. `duplicate` significa que o trabalho já tinha sido impresso: trate como concluído.
- `POST /v1/agent/status` ← `{ agent, printers, routes }`, enviado a cada 5 min.

`payload` é um JSON (string) assinado: `{ v: 1, id, deviceId, ts, expiresAt, route?, printer?, copies?, jobName?, document? | text? | image? | raw? | pdf? | html?, pdfOptions?, htmlOptions?, options? }`. Reentregue trabalhos sem resultado depois de ~2 min.
