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
