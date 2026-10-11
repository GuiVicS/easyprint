# Segurança do EasyPrint

## Como relatar uma falha

**Não abra uma issue pública** com detalhes de exploração. Use o [aviso privado de vulnerabilidade do GitHub](https://github.com/GuiVicS/easyprint/security/advisories/new). Respondemos o mais rápido possível e combinamos a divulgação depois da correção.

## Versões com suporte

Só a versão mais recente recebe correções. O EasyPrint avisa no painel quando há uma nova versão.

## Modelo de ameaças

### O que o EasyPrint protege

| Ameaça | Proteção |
|---|---|
| Alguém na rede da loja ou na internet acessar o agente | Escuta só em `127.0.0.1`. Nenhuma porta fica exposta. |
| Um site qualquer imprimir | Cada `Origin` precisa ser aprovado pelo lojista com um clique. O endereço vem do navegador e uma página não consegue falsificá-lo. |
| Sites maliciosos atacando o painel (CSRF, DNS rebinding) | Token de administrador por execução, checagem de `Host` e de `Origin`. |
| Site aprovado, mas invadido (XSS no ERP) | A gaveta fica bloqueada por padrão e é liberada por site/app. Há limite de 120 impressões/min e 2000/h por origem, com alerta na bandeja. |
| Site não aprovado abusando antes da permissão | Mensagens de até 64 KB, 30 mensagens a cada 10 s, 10 conexões por origem e 64 no total, e no máximo 5 pedidos de permissão pendentes. |
| Relay da nuvem invadido ou malicioso | Trabalhos **assinados** (Ed25519): o relay não forja impressões. Trabalhos **cifrados** de ponta a ponta (X25519 + HKDF + AES-256-GCM): o relay não lê o conteúdo. A chave da loja é autenticada por um segredo fora do relay, então trocar a chave é detectado. |
| Código de conexão vazado (foto da tela) | Uso único: depois do pareamento, o código não vale mais. |
| Reenvio de trabalhos (replay), trabalho de outra loja | Trabalhos com `id` único persistido, validade máxima de 7 dias e vínculo com o `deviceId`. |
| Leitura dos segredos no disco | Token do dispositivo e chave privada protegidos com DPAPI no Windows. Configuração em arquivo `0600` no Linux. |
| HTML malicioso | Renderizado em navegador headless com perfil separado. A CSP bloqueia scripts, rede local (`http://`), `file://`, iframes e formulários. |
| Imagens/PDF maliciosos | PNG com limite de dimensões e de descompressão (contra bomba de zip). PDF com limite de 25 MB e de páginas, renderizado pelos componentes do sistema. |
| Binário adulterado | A release publica `SHA256SUMS`, e o `install.sh` confere o hash antes de instalar. |

### O que está fora do alcance

- **Computador já comprometido.** Um malware rodando como o mesmo usuário pode ler o token do painel e se passar por um site aprovado. Nessa situação, o atacante já tem acesso equivalente ao usuário.
- **Chave privada do ERP vazada.** Quem tiver a chave Ed25519 do seu sistema *e* acesso ao relay consegue enviar impressões. Guarde a chave em cofre ou variável de ambiente e gire-a se houver suspeita (gere novas chaves e reconecte as lojas).
- **Falhas nos componentes do sistema** (leitor de PDF do Windows, poppler, navegador headless). Mantenha o sistema operacional e o navegador atualizados.
- **Engenharia social:** o lojista aprovar um site falso. A janela de permissão mostra o endereço real em destaque. Oriente a equipe a recusar endereços desconhecidos.
- **Executável sem assinatura digital de código:** confira o hash SHA-256 da release, ou compile a partir do código-fonte.

## Para quem distribui (mantenedores)

- Ative a autenticação em dois fatores na conta do GitHub.
- Publique sempre o `SHA256SUMS` junto com os binários (`npm run build:exe` gera).
- Assine o executável do Windows quando houver um certificado de assinatura de código.
