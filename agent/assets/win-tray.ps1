# EasyPrint — ícone na bandeja do Windows.
param([int]$Port, [string]$Admin, [int]$ParentPid, [string]$IconPath, [string]$Browser)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$base = "http://127.0.0.1:$Port"
$headers = @{ 'X-EasyPrint-Admin' = $Admin }

# Ícone oficial (+ variante com ponto laranja quando um site pede permissão)
$baseIcon = if ($IconPath -and (Test-Path $IconPath)) { New-Object System.Drawing.Icon($IconPath, 32, 32) } else { [System.Drawing.SystemIcons]::Application }
function New-WarnIcon($icon) {
  $bmp = $icon.ToBitmap()
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.FillEllipse([System.Drawing.Brushes]::White, 17, 17, 15, 15)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#f59e0b'))), 19, 19, 11, 11)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$iconOk = $baseIcon
$iconWarn = New-WarnIcon $baseIcon

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $iconOk
$tray.Text = 'EasyPrint - pronto para imprimir'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.RenderMode = 'System'
$menu.ShowImageMargin = $false
$menu.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$open = $menu.Items.Add('Abrir painel do EasyPrint')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$wizard = $menu.Items.Add('Assistente de configuração')
$test = $menu.Items.Add('Imprimir página de teste')
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Sair do EasyPrint')
$tray.ContextMenuStrip = $menu

function Open-Panel([string]$hash) {
  $url = "$base/$hash"
  if ($Browser -and (Test-Path $Browser)) { Start-Process -FilePath $Browser -ArgumentList "--app=$url", '--window-size=1180,820' }
  else { Start-Process $url }
}

$open.add_Click({ Open-Panel '' })
$wizard.add_Click({ Open-Panel '#/assistente' })
$tray.add_DoubleClick({ Open-Panel '' })
$test.add_Click({
  try { Invoke-RestMethod -Method Post -Uri "$base/api/admin/test-print" -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null
        $tray.ShowBalloonTip(3000, 'EasyPrint', 'Página de teste enviada.', 'Info') }
  catch { $tray.ShowBalloonTip(5000, 'EasyPrint', 'Não foi possível imprimir o teste. Abra o painel para ver o motivo.', 'Warning') }
})
$quit.add_Click({
  $r = [System.Windows.Forms.MessageBox]::Show("Se você sair, os sites não conseguirão imprimir até o EasyPrint ser aberto de novo.`n`nDeseja sair mesmo?", 'Sair do EasyPrint', 'YesNo', 'Warning')
  if ($r -eq 'Yes') {
    try { Invoke-RestMethod -Method Post -Uri "$base/api/admin/quit" -Headers $headers -ContentType 'application/json' -Body '{}' | Out-Null } catch {}
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})

$tray.ShowBalloonTip(4000, 'EasyPrint', 'Pronto! Os sites autorizados já podem imprimir.', 'Info')

# Consulta notificações do agente (ex.: novo site pedindo permissão) e encerra junto com ele
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $tray.Visible = $false; [System.Windows.Forms.Application]::Exit(); return
  }
  try {
    $n = (Invoke-RestMethod -Uri "$base/api/admin/tray" -Headers $headers -TimeoutSec 2).result
    foreach ($msg in @($n.notifications)) {
      if ($msg) { $tray.ShowBalloonTip(6000, $msg.title, $msg.text, $msg.level) }
    }
    if ($n.pending -gt 0) { $tray.Icon = $iconWarn; $tray.Text = 'EasyPrint - um site pede permissão' }
    else { $tray.Icon = $iconOk; $tray.Text = 'EasyPrint - pronto para imprimir' }
  } catch {}
})
$timer.Start()

$tray.add_BalloonTipClicked({ Open-Panel '' })

[System.Windows.Forms.Application]::Run()
$tray.Dispose()
