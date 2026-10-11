# Gera os PNGs do ícone do EasyPrint (16 a 256 px). Uso: powershell -File tools/make-icon.ps1 <pasta-saida>
param([string]$Out)
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $Out | Out-Null

function RoundRect([System.Drawing.Drawing2D.GraphicsPath]$p, [single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
}

foreach ($size in 16, 24, 32, 48, 64, 128, 256) {
  $s = [single]$size / 256.0
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  # Fundo: "squircle" com gradiente verde
  $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
  RoundRect $bg (8 * $s) (8 * $s) (240 * $s) (240 * $s) (56 * $s)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0, 0)), ([System.Drawing.PointF]::new($size, $size)), ([System.Drawing.ColorTranslator]::FromHtml('#34d27a')), ([System.Drawing.ColorTranslator]::FromHtml('#0f7a3c'))
  $g.FillPath($grad, $bg)

  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $soft = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 255, 255, 255))
  $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0f7a3c'))

  # Papel de trás (saindo por cima)
  $paper = New-Object System.Drawing.Drawing2D.GraphicsPath
  RoundRect $paper (82 * $s) (46 * $s) (92 * $s) (70 * $s) (10 * $s)
  $g.FillPath($soft, $paper)
  # Corpo da impressora
  $body = New-Object System.Drawing.Drawing2D.GraphicsPath
  RoundRect $body (52 * $s) (96 * $s) (152 * $s) (80 * $s) (22 * $s)
  $g.FillPath($white, $body)
  # Fenda
  $g.FillRectangle($ink, [single](78 * $s), [single](146 * $s), [single](100 * $s), [single]([Math]::Max(1, 8 * $s)))
  # Cupom saindo, com linhas de texto
  $receipt = New-Object System.Drawing.Drawing2D.GraphicsPath
  RoundRect $receipt (86 * $s) (150 * $s) (84 * $s) (66 * $s) (6 * $s)
  $g.FillPath($white, $receipt)
  if ($size -ge 32) {
    foreach ($i in 0, 1, 2) {
      $w = @(56, 44, 30)[$i]
      $g.FillRectangle($ink, [single](100 * $s), [single]((168 + $i * 14) * $s), [single]($w * $s), [single]([Math]::Max(1, 5 * $s)))
    }
  }
  # Indicador "pronto"
  $g.FillEllipse($ink, [single](172 * $s), [single](112 * $s), [single](14 * $s), [single](14 * $s))

  $g.Dispose()
  $bmp.Save((Join-Path $Out "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
