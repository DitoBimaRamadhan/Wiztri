# release.ps1 — buat GitHub Release + upload installer ke repo.
# Cara pakai:
#   1. (opsional) bangun dulu:  npm run dist
#   2. Set token:  $env:GITHUB_TOKEN="ghp_..."   (atau akan diminta)
#   3. Jalankan:   powershell -ExecutionPolicy Bypass -File scripts/release.ps1
param(
  [string]$Tag = "v0.2.0",
  [string]$Repo = "DitoBimaRamadhan/Wiztri",
  [string]$Title = "Wiztri 0.2.0",
  [string]$Notes = "Rilis Wiztri 0.2.0. Unduh `wiztri setup.exe` (x64, Windows NTFS). Lihat CHANGELOG.md untuk detail.",
  [string]$Asset = "installer/wiztri setup.exe",
  [string]$AssetName = "wiztri.setup.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Asset)) { throw "Asset tak ditemukan: $Asset — jalankan 'npm run dist' dulu." }

$Token = $env:GITHUB_TOKEN
if (-not $Token) {
  $Token = Read-Host -Prompt "GITHUB_TOKEN (buat di github.com/settings/tokens, scope 'repo')"
  if (-not $Token) { throw "Token wajib." }
}

# Pastikan tag ada & terpush
if (-not (git tag | Select-String -Quiet "^$([regex]::Escape($Tag))$")) {
  git tag -a $Tag -m "Rilis $Title"
}
git push origin $Tag

$headers = @{ Authorization = "Bearer $Token"; Accept = "application/vnd.github+json" }

# Cek release sudah ada? update : buat
try {
  $existing = Invoke-RestMethod -Method Get -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers
  Write-Host "Release '$Tag' sudah ada — update."
} catch {
  $body = @{ tag_name = $Tag; name = $Title; body = $Notes; draft = $false; prerelease = $false } | ConvertTo-Json
  $existing = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body $body -ContentType "application/json"
  Write-Host "Release '$Tag' dibuat."
}

# Hapus asset lama bernama sama (jika ada) agar upload bisa menimpa.
foreach ($a in $existing.assets) {
  if ($a.name -eq $AssetName) {
    Invoke-RestMethod -Method Delete -Uri $a.url -Headers $headers | Out-Null
    Write-Host "Hapus asset lama '$AssetName'."
  }
}

# Upload asset via Invoke-RestMethod (token hanya di memori, tak tampil di cmdline).
$uploadUrl = $existing.upload_url -replace '\{.*$',''
$assetName = $AssetName
Write-Host "Upload '$assetName' ke release..."
$file = [System.IO.File]::ReadAllBytes((Resolve-Path $Asset))
Invoke-RestMethod -Method Post -Uri "$uploadUrl?name=$([uri]::EscapeDataString($assetName))" `
  -Headers $headers -ContentType "application/octet-stream" -Body $file | Out-Null

Write-Host ""
Write-Host "Berhasil! Unduh:"
Write-Host "  Browser: https://github.com/$Repo/releases/latest"
Write-Host "  CLI gh: gh release download $Tag --repo $Repo"
Write-Host "  curl:   curl -L https://github.com/$Repo/releases/download/$Tag/$([uri]::EscapeDataString($assetName)) -o $assetName"
