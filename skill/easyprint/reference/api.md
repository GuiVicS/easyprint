# EasyPrint SDK — referência da API

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
