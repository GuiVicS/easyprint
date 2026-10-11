# Status, erros e o que mostrar ao usuário

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
| `POLICY_BLOCKED` | (Nuvem) O lojista bloqueou gaveta, RAW ou PDF nessa conexão. | Explicar que precisa liberar em EasyPrint → Nuvem. |

## Problemas comuns na loja

- **Acentos errados na térmica:** Painel → Impressoras → Ajustar → Acentos. Teste CP860 e depois CP850. O assistente faz isso automaticamente.
- **Texto cortado:** a largura do papel está errada (58 ou 80 mm).
- **A impressora não aparece:** falta o driver do fabricante, ou instale "Generic / Text Only". No Linux, térmicas USB aparecem como "USB direto (lp0)". Se der erro de permissão, rode `sudo usermod -aG lp $USER` e entre de novo na sessão.
- **Finalidade saindo na impressora errada:** Painel → Impressoras → Finalidades.
- **Chrome perguntou "acessar apps neste dispositivo":** é normal; clique em Permitir.
