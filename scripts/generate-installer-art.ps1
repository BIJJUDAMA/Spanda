$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDirectory = Join-Path $projectRoot 'src-tauri/installer'
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

# Export the existing brand artwork to the bitmap sizes required by NSIS.
function New-Canvas([int]$Width, [int]$Height) {
    $bitmap = New-Object Drawing.Bitmap($Width, $Height, ([Drawing.Imaging.PixelFormat]::Format24bppRgb))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    return [pscustomobject]@{ Bitmap = $bitmap; Graphics = $graphics }
}

function Draw-FittedImage($Graphics, $Image, [Drawing.RectangleF]$Bounds) {
    $scale = [Math]::Min($Bounds.Width / $Image.Width, $Bounds.Height / $Image.Height)
    $width = [single]($Image.Width * $scale)
    $height = [single]($Image.Height * $scale)
    $destination = New-Object Drawing.RectangleF(
        ($Bounds.X + ($Bounds.Width - $width) / 2),
        ($Bounds.Y + ($Bounds.Height - $height) / 2), $width, $height)
    $Graphics.DrawImage($Image, $destination)
}

function Draw-CenteredText($Graphics, [string]$Text, [single]$Size, [string]$Color, [Drawing.RectangleF]$Bounds, [bool]$Bold = $false) {
    $style = if ($Bold) { [Drawing.FontStyle]::Bold } else { [Drawing.FontStyle]::Regular }
    $font = New-Object Drawing.Font('Segoe UI', $Size, $style, ([Drawing.GraphicsUnit]::Pixel))
    $brush = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($Color))
    $format = New-Object Drawing.StringFormat
    $format.Alignment = [Drawing.StringAlignment]::Center
    $format.LineAlignment = [Drawing.StringAlignment]::Center
    try { $Graphics.DrawString($Text, $font, $brush, $Bounds, $format) }
    finally { $font.Dispose(); $brush.Dispose(); $format.Dispose() }
}

$banner = [Drawing.Image]::FromFile((Join-Path $projectRoot 'assets/banner.png'))
$logo = [Drawing.Image]::FromFile((Join-Path $projectRoot 'assets/logo.png'))
$header = New-Canvas 300 114
$sidebar = New-Canvas 328 628
try {
    $header.Graphics.Clear([Drawing.ColorTranslator]::FromHtml('#0B0E15'))
    Draw-FittedImage $header.Graphics $banner (New-Object Drawing.RectangleF(10, 8, 280, 98))
    $header.Bitmap.Save((Join-Path $outputDirectory 'header.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)

    $bounds = New-Object Drawing.Rectangle(0, 0, 328, 628)
    $background = New-Object Drawing.Drawing2D.LinearGradientBrush($bounds,
        ([Drawing.ColorTranslator]::FromHtml('#0B0E15')),
        ([Drawing.ColorTranslator]::FromHtml('#15373F')), 70)
    try { $sidebar.Graphics.FillRectangle($background, $bounds) } finally { $background.Dispose() }
    Draw-FittedImage $sidebar.Graphics $logo (New-Object Drawing.RectangleF(30, 88, 268, 268))
    Draw-CenteredText $sidebar.Graphics 'SPANDA' 42 '#FFFFFF' (New-Object Drawing.RectangleF(16, 382, 296, 58)) $true
    Draw-CenteredText $sidebar.Graphics "Where sound`ntakes shape" 26 '#E2EEF1' (New-Object Drawing.RectangleF(16, 454, 296, 84))
    $sidebar.Bitmap.Save((Join-Path $outputDirectory 'sidebar.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
}
finally {
    $banner.Dispose(); $logo.Dispose()
    $header.Graphics.Dispose(); $header.Bitmap.Dispose()
    $sidebar.Graphics.Dispose(); $sidebar.Bitmap.Dispose()
}
Write-Output 'Generated Spanda NSIS header and sidebar bitmaps.'
