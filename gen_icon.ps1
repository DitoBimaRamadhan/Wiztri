# Bangun build/icon.ico + build/icon.png dari Wiztri.jpeg.
# KUNCI: crop persegi dulu ke TOPI (bukan banner penuh 2752x1536 yang berisi
# teks "Wiztri"/"DISK USAGE ANALYZER" + padding gelap). Banner penuh dipaksa
# persegi -> di 16px jadi kotak biru kosong. Crop ke topi saja.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$srcPath = Join-Path $PSScriptRoot 'Wiztri.jpeg'
$outDir = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$icoPath = Join-Path $outDir 'icon.ico'
$pngPath = Join-Path $outDir 'icon.png'

$src = [System.Drawing.Image]::FromFile($srcPath)

# Crop terverifikasi: topi saja (tanpa teks "Wiztri"), 860x860 @ 960,225.
$crop = New-Object System.Drawing.Rectangle(960, 225, 860, 860)

# PNG master 512 (untuk BrowserWindow dev + fallback)
$master = New-Object System.Drawing.Bitmap(512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($master)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, 512, 512)), $crop, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$master.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = @()
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gg = [System.Drawing.Graphics]::FromImage($bmp)
    $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $gg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gg.Clear([System.Drawing.Color]::Transparent)
    $gg.DrawImage($master, 0, 0, $s, $s)
    $gg.Dispose()

    if ($s -eq 256) {
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $blob = $ms.ToArray(); $ms.Dispose()
    } else {
        $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
        $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $pix = New-Object byte[] ($data.Stride * $s)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pix, 0, $pix.Length)
        $bmp.UnlockBits($data)
        $rows = @()
        for ($y = 0; $y -lt $s; $y++) {
            $start = $y * $data.Stride
            $rowBytes = New-Object byte[] ($s * 4)
            [Array]::Copy($pix, $start, $rowBytes, 0, $s * 4)
            $rows += ,$rowBytes
        }
        [Array]::Reverse($rows)
        $pixelData = New-Object System.IO.MemoryStream
        foreach ($r in $rows) { $pixelData.Write($r, 0, $r.Length) }

        $maskStride = [math]::Ceiling($s / 32.0) * 4
        $mask = New-Object byte[] ($maskStride * $s)
        $hdr = New-Object byte[] 40
        [BitConverter]::GetBytes([int]40).CopyTo($hdr, 0)
        [BitConverter]::GetBytes([int]$s).CopyTo($hdr, 4)
        [BitConverter]::GetBytes([int]($s * 2)).CopyTo($hdr, 8)
        [BitConverter]::GetBytes([int16]1).CopyTo($hdr, 12)
        [BitConverter]::GetBytes([int16]32).CopyTo($hdr, 14)
        $blob = $hdr + $pixelData.ToArray() + $mask
        $pixelData.Dispose()
    }
    $bmp.Dispose()
    $entries += [PSCustomObject]@{ w = if ($s -eq 256) { 0 } else { $s }; h = if ($s -eq 256) { 0 } else { $s }; blob = $blob }
}
$src.Dispose(); $master.Dispose()

$fs = [System.IO.File]::Create($icoPath)
$bw2 = New-Object System.IO.BinaryWriter($fs)
$bw2.Write([uint16]0); $bw2.Write([uint16]1); $bw2.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $bw2.Write([byte]$e.w); $bw2.Write([byte]$e.h)
    $bw2.Write([byte]0); $bw2.Write([byte]0)
    $bw2.Write([uint16]1); $bw2.Write([uint16]32)
    $bw2.Write([uint32]$e.blob.Length)
    $bw2.Write([uint32]$offset)
    $offset += $e.blob.Length
}
foreach ($e in $entries) { $bw2.Write($e.blob) }
$bw2.Flush(); $fs.Close()
Write-Output ("crop: 860x860 @ 960,225")
Write-Output ("png : {0} [{1} bytes]" -f $pngPath, (Get-Item $pngPath).Length)
Write-Output ("ico : {0} [{1} bytes]" -f $icoPath, (Get-Item $icoPath).Length)
