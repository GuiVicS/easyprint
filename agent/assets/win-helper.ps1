# EasyPrint — helper de impressão do Windows.
# Processo persistente: lê comandos JSON (uma linha por comando) no stdin e responde JSON no stdout.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class EasyPrintRaw {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFO {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool ClosePrinter(IntPtr h);
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndDocPrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool StartPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);

    public static int Send(string printer, byte[] data, string docName) {
        IntPtr h;
        if (!OpenPrinter(printer, out h, IntPtr.Zero)) return Marshal.GetLastWin32Error();
        try {
            var di = new DOCINFO { pDocName = docName, pDataType = "RAW" };
            int job = StartDocPrinter(h, 1, di);
            if (job == 0) return Marshal.GetLastWin32Error();
            try {
                if (!StartPagePrinter(h)) return Marshal.GetLastWin32Error();
                int written;
                bool ok = WritePrinter(h, data, data.Length, out written);
                EndPagePrinter(h);
                if (!ok || written != data.Length) return Marshal.GetLastWin32Error();
            } finally { EndDocPrinter(h); }
        } finally { ClosePrinter(h); }
        return 0;
    }
}
'@

function Get-Printers {
  $default = (Get-CimInstance -ClassName Win32_Printer -Filter 'Default=TRUE' -ErrorAction SilentlyContinue | Select-Object -First 1).Name
  Get-CimInstance -ClassName Win32_Printer | ForEach-Object {
    [ordered]@{
      name      = $_.Name
      driver    = $_.DriverName
      port      = $_.PortName
      isDefault = ($_.Name -eq $default)
      offline   = [bool]$_.WorkOffline
      status    = [int]$_.PrinterStatus
      network   = [bool]$_.Network
      shared    = [bool]$_.Shared
    }
  }
}

function Invoke-OfficePrint($cmd) {
  # Imprime linhas (texto/imagem) em impressora comum via GDI
  $lines = $cmd.lines
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $cmd.printer
  if (-not $doc.PrinterSettings.IsValid) { throw "PRINTER_NOT_FOUND" }
  $doc.DocumentName = $cmd.docName
  if ($cmd.copies) { $doc.PrinterSettings.Copies = [int16]$cmd.copies }
  $state = @{ i = 0 }
  $baseSize = if ($cmd.fontSize) { [single]$cmd.fontSize } else { [single]10 }
  $doc.add_PrintPage({
    param($s, $e)
    $g = $e.Graphics
    $area = $e.MarginBounds
    $y = [single]$area.Top
    while ($state.i -lt $lines.Count) {
      $l = $lines[$state.i]
      if ($l.kind -eq 'text') {
        $style = if ($l.bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
        $font = New-Object System.Drawing.Font('Consolas', ($baseSize * [single]$l.size), $style)
        $h = $font.GetHeight($g)
        if ($y + $h -gt $area.Bottom -and $y -gt $area.Top) { $e.HasMorePages = $true; $font.Dispose(); return }
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = switch ($l.align) { 'center' { 'Center' } 'right' { 'Far' } default { 'Near' } }
        $rect = New-Object System.Drawing.RectangleF($area.Left, $y, $area.Width, $h)
        $g.DrawString([string]$l.text, $font, [System.Drawing.Brushes]::Black, $rect, $fmt)
        $y += $h; $font.Dispose()
      } elseif ($l.kind -eq 'image' -and $l.file) {
        $img = [System.Drawing.Image]::FromFile($l.file)
        $w = [Math]::Min($area.Width, $img.Width); $h = $img.Height * ($w / $img.Width)
        if ($y + $h -gt $area.Bottom -and $y -gt $area.Top) { $e.HasMorePages = $true; $img.Dispose(); return }
        $x = switch ($l.align) { 'left' { $area.Left } 'right' { $area.Right - $w } default { $area.Left + ($area.Width - $w) / 2 } }
        $g.DrawImage($img, [single]$x, $y, [single]$w, [single]$h); $y += $h + 4; $img.Dispose()
      } elseif ($l.kind -eq 'feed') {
        $y += 16 * [int]$l.lines
      }
      $state.i++
    }
    $e.HasMorePages = $false
  })
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $doc.Print()
  $doc.Dispose()
}

# ---------- PDF (renderizado pela API nativa do Windows 10/11: Windows.Data.Pdf) ----------
$script:pdfReady = $false
function Initialize-Pdf {
  if ($script:pdfReady) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $script:asTaskOp = $methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  $script:asTaskAction = $methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
  $script:pdfReady = $true
}
function Wait-Op($op, [Type]$type) {
  $t = $script:asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(60000)) { throw 'PDF_TIMEOUT' }
  return $t.Result
}
function Wait-Action($action) {
  $t = $script:asTaskAction.Invoke($null, @($action))
  if (-not $t.Wait(60000)) { throw 'PDF_TIMEOUT' }
}

function Invoke-PdfRender($cmd) {
  Initialize-Pdf
  $file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cmd.file)) ([Windows.Storage.StorageFile])
  try { $pdf = Wait-Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument]) }
  catch { throw 'PDF_INVALID' }
  if ($pdf.IsPasswordProtected) { throw 'PDF_PASSWORD' }
  $count = [int]$pdf.PageCount
  $indexes = if ($cmd.pages) { @($cmd.pages | ForEach-Object { [int]$_ } | Where-Object { $_ -ge 0 -and $_ -lt $count }) } else { 0..($count - 1) }
  $max = if ($cmd.maxPages) { [int]$cmd.maxPages } else { 200 }
  if ($indexes.Count -gt $max) { throw "PDF_TOO_MANY_PAGES:$($indexes.Count)" }
  $out = @()
  foreach ($i in $indexes) {
    $page = $pdf.GetPage([uint32]$i)
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    if ($cmd.width) { $w = [uint32]$cmd.width } else { $w = [uint32][Math]::Round($page.Size.Width / 96.0 * [double]$cmd.dpi) }
    $opts.DestinationWidth = $w
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    Wait-Action ($page.RenderToStreamAsync($stream, $opts))
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
    $net.Position = 0
    $target = Join-Path $cmd.outDir ("page-{0:D4}.png" -f $i)
    $fs = [System.IO.File]::Create($target); $net.CopyTo($fs); $fs.Dispose(); $net.Dispose()
    $img = [System.Drawing.Image]::FromFile($target)
    $out += [ordered]@{ index = $i; file = $target; width = $img.Width; height = $img.Height; widthIn = [double]($page.Size.Width / 96.0); heightIn = [double]($page.Size.Height / 96.0) }
    $img.Dispose(); $page.Dispose()
  }
  return [ordered]@{ pageCount = $count; pages = @($out) }
}

# Imprime imagens (uma por página) — usado para PDF em impressoras comuns
function Invoke-ImagesPrint($cmd) {
  $files = @($cmd.files)
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $cmd.printer
  if (-not $doc.PrinterSettings.IsValid) { throw 'PRINTER_NOT_FOUND' }
  $doc.DocumentName = $cmd.docName
  if ($cmd.copies) { $doc.PrinterSettings.Copies = [int16]$cmd.copies }
  if ($cmd.paperSize -and $cmd.paperSize -ne 'auto') {
    $match = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -like "*$($cmd.paperSize)*" -or $_.Kind.ToString() -eq $cmd.paperSize } | Select-Object -First 1
    if ($match) { $doc.DefaultPageSettings.PaperSize = $match }
  }
  $m = if ($null -ne $cmd.marginHundredths) { [int]$cmd.marginHundredths } else { 20 }
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins($m, $m, $m, $m)
  $state = @{ i = 0 }
  $doc.add_QueryPageSettings({
    param($s, $e)
    if ($state.i -lt $files.Count) {
      $img = [System.Drawing.Image]::FromFile($files[$state.i])
      $e.PageSettings.Landscape = ($img.Width -gt $img.Height)
      $img.Dispose()
    }
  })
  $doc.add_PrintPage({
    param($s, $e)
    $img = [System.Drawing.Image]::FromFile($files[$state.i])
    $area = $e.MarginBounds
    if ($cmd.fit -eq 'actual') {
      $w = $img.Width / $img.HorizontalResolution * 100; $h = $img.Height / $img.VerticalResolution * 100
    } else {
      $scale = [Math]::Min($area.Width / $img.Width, $area.Height / $img.Height)
      $w = $img.Width * $scale; $h = $img.Height * $scale
    }
    $x = $area.Left + ($area.Width - $w) / 2; $y = $area.Top
    $e.Graphics.InterpolationMode = 'HighQualityBicubic'
    $e.Graphics.DrawImage($img, [single]$x, [single]$y, [single]$w, [single]$h)
    $img.Dispose()
    $state.i++
    $e.HasMorePages = ($state.i -lt $files.Count)
  })
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
  $doc.Print()
  $doc.Dispose()
}

# Proteção de segredos com DPAPI (só o mesmo usuário do Windows consegue ler)
Add-Type -AssemblyName System.Security
function Protect-Text([string]$text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, [System.Text.Encoding]::UTF8.GetBytes('EasyPrint'), 'CurrentUser')
  return [Convert]::ToBase64String($enc)
}
function Unprotect-Text([string]$data) {
  $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($data), [System.Text.Encoding]::UTF8.GetBytes('EasyPrint'), 'CurrentUser')
  return [System.Text.Encoding]::UTF8.GetString($bytes)
}

function Send-Reply($id, $ok, $payload) {
  $o = [ordered]@{ id = $id; ok = $ok }
  if ($ok) { $o.result = $payload } else { $o.error = $payload }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

[Console]::Out.WriteLine('{"ready":true}'); [Console]::Out.Flush()

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $cmd = $null
  try {
    $cmd = $line | ConvertFrom-Json
    switch ($cmd.cmd) {
      'ping' { Send-Reply $cmd.id $true 'pong' }
      'list' { Send-Reply $cmd.id $true @(Get-Printers) }
      'raw' {
        $bytes = [System.IO.File]::ReadAllBytes($cmd.file)
        $copies = if ($cmd.copies) { [int]$cmd.copies } else { 1 }
        for ($c = 0; $c -lt $copies; $c++) {
          $err = [EasyPrintRaw]::Send($cmd.printer, $bytes, $cmd.docName)
          if ($err -ne 0) { throw "WIN32_$err" }
        }
        Send-Reply $cmd.id $true @{ bytes = $bytes.Length }
      }
      'office' {
        Invoke-OfficePrint $cmd
        Send-Reply $cmd.id $true @{ lines = $cmd.lines.Count }
      }
      'pdf-render' { Send-Reply $cmd.id $true (Invoke-PdfRender $cmd) }
      'images' {
        Invoke-ImagesPrint $cmd
        Send-Reply $cmd.id $true @{ pages = @($cmd.files).Count }
      }
      'protect' { Send-Reply $cmd.id $true (Protect-Text $cmd.text) }
      'unprotect' { Send-Reply $cmd.id $true (Unprotect-Text $cmd.data) }
      default { Send-Reply $cmd.id $false 'UNKNOWN_COMMAND' }
    }
  } catch {
    $id = if ($cmd) { $cmd.id } else { $null }
    Send-Reply $id $false ([string]$_.Exception.Message)
  }
}
