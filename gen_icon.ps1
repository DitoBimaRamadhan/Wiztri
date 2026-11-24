# Buat build/icon.ico multi-ukuran dari Wiztri.jpeg
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$srcPath = Join-Path $PSScriptRoot 'Wiztri.jpeg'
$outDir = Join-Path $PSScriptRoot 'build'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$icoPath = Join-Path $outDir 'icon.ico'

$src = [System.Drawing.Image]::FromFile($srcPath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)

# kumpulkan blob + entry
$entries = @()   # PSCustomObject {w,h,blob}
foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()

    # ambil pixel BGRA (top-down)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $pix = New-Object byte[] ($data.Stride * $s)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pix, 0, $pix.Length)
    $bmp.UnlockBits($data)

    # baris bottom-up (DIB)
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

    # mask AND (1bpp) baris top-down, all-zero
    $maskStride = [math]::Ceiling($s / 32.0) * 4
    $mask = New-Object byte[] ($maskStride * $s)

    if ($s -eq 256) {
        # PNG
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $blob = $ms.ToArray()
        $ms.Dispose()
    } else {
        # DIB: BITMAPINFOHEADER + pixel + mask
        $hdr = New-Object byte[] 40
        [BitConverter]::GetBytes([int]40).CopyTo($hdr, 0)
        [BitConverter]::GetBytes([int]$s).CopyTo($hdr, 4)
        [BitConverter]::GetBytes([int]($s * 2)).CopyTo($hdr, 8)
        [BitConverter]::GetBytes([int16]1).CopyTo($hdr, 12)
        [BitConverter]::GetBytes([int16]32).CopyTo($hdr, 14)
        [BitConverter]::GetBytes([int]0).CopyTo($hdr, 16)
        $blob = $hdr + $pixelData.ToArray() + $mask
    }
    $pixelData.Dispose()
    $bmp.Dispose()
    $entries += [PSCustomObject]@{ w = if ($s -eq 256) { 0 } else { $s }; h = if ($s -eq 256) { 0 } else { $s }; blob = $blob }
}
$src.Dispose()

# tulis ICO
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$entries.Count)
$offset = 6 + 16 * $entries.Count
foreach ($e in $entries) {
    $bw.Write([byte]$e.w); $bw.Write([byte]$e.h)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$e.blob.Length)
    $bw.Write([uint32]$offset)
    $offset += $e.blob.Length
}
foreach ($e in $entries) { $bw.Write($e.blob) }
$bw.Flush(); $fs.Close()
Write-Output ("icon written: {0} [{1} bytes]" -f $icoPath, (Get-Item $icoPath).Length)
