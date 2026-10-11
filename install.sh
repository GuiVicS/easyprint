#!/bin/sh
# Instalador do EasyPrint para Linux (x64). Não precisa de root.
#   curl -fsSL https://github.com/GuiVicS/easyprint/raw/main/install.sh | sh
# O binário só é instalado se o hash SHA-256 conferir com o SHA256SUMS da release.
set -eu

REPO="GuiVicS/easyprint"
BASE="https://github.com/$REPO/releases/latest/download"
DEST="$HOME/.local/bin/easyprint"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) ;;
  *) echo "✖ Este instalador é para Linux x64. Seu sistema: $(uname -s) $(uname -m)"; exit 1 ;;
esac

fetch() { # url destino
  if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q --show-progress "$1" -O "$2"
  else echo "✖ Instale o curl ou o wget e tente de novo."; exit 1; fi
}

TMPDIR_EP="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EP"' EXIT

echo "→ Baixando o EasyPrint…"
fetch "$BASE/easyprint-linux-x64" "$TMPDIR_EP/easyprint-linux-x64"
fetch "$BASE/SHA256SUMS" "$TMPDIR_EP/SHA256SUMS"

echo "→ Conferindo a integridade (SHA-256)…"
EXPECTED="$(grep ' easyprint-linux-x64$' "$TMPDIR_EP/SHA256SUMS" | cut -d' ' -f1)"
if command -v sha256sum >/dev/null 2>&1; then ACTUAL="$(sha256sum "$TMPDIR_EP/easyprint-linux-x64" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMPDIR_EP/easyprint-linux-x64" | cut -d' ' -f1)"
else echo "✖ Não encontrei sha256sum nem shasum para conferir o download."; exit 1; fi
if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "✖ O arquivo baixado NÃO confere com o hash publicado. Instalação cancelada por segurança."
  exit 1
fi
echo "✔ Integridade conferida ($ACTUAL)"

mkdir -p "$(dirname "$DEST")"
mv "$TMPDIR_EP/easyprint-linux-x64" "$DEST"
chmod +x "$DEST"
echo "✔ Instalado em $DEST"

# Dicas de dependências opcionais
command -v lp >/dev/null 2>&1 || echo "ℹ Para usar impressoras do sistema, instale o CUPS: sudo apt install cups"
command -v pdftoppm >/dev/null 2>&1 || echo "ℹ Para PDF em térmicas/etiquetas: sudo apt install poppler-utils"
if ! command -v chromium >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  echo "ℹ Para imprimir HTML, instale o Chromium ou o Google Chrome"
fi
if ls /dev/usb/lp* >/dev/null 2>&1 && ! id -nG | grep -qw lp; then
  echo "ℹ Térmica USB detectada. Para usá-la: sudo usermod -aG lp \$USER (depois saia e entre na sessão)"
fi

echo "→ Abrindo o EasyPrint…"
nohup "$DEST" >/dev/null 2>&1 &
echo "✔ Pronto! O assistente vai abrir no navegador. Ele também está no menu de aplicativos."
