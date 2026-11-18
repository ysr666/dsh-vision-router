param([Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$bitmap=[System.Drawing.Bitmap]::new(760,160,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
$font=[System.Drawing.Font]::new('Arial',72,[System.Drawing.FontStyle]::Regular)
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawString('HELLO 123',$font,[System.Drawing.Brushes]::Black,[single]16,[single]12)
  $bitmap.Save($Output,[System.Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
