#!/bin/sh
# Instalador do EasyPrint para Linux (x64). Não precisa de root.
#   curl -fsSL https://github.com/GuiVicS/easyprint/raw/main/install.sh | sh
set -eu

REPO="GuiVicS/easyprint"
URL="https://github.com/$REPO/releases/latest/download/easyprint-linux-x64"
DEST="$HOME/.local/bin/easyprint"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) ;;
  *) echo "✖ Este instalador é para Linux x64. Seu sistema: $(uname -s) $(uname -m)"; exit 1 ;;
esac

echo "→ Baixando o EasyPrint…"
TMP="$(mktemp)"
if command -v curl >/dev/null 2>&1; then curl -fL --progress-bar "$URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then wget -q --show-progress "$URL" -O "$TMP"
else echo "✖ Instale o curl ou o wget e tente de novo."; exit 1; fi

mkdir -p "$(dirname "$DEST")"
mv "$TMP" "$DEST"
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
