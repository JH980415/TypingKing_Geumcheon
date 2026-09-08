param(
  [string]$ProjectRoot = (Join-Path $PSScriptRoot '..')
)
$ErrorActionPreference = 'Stop'
$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$sourceRoot = (Resolve-Path (Join-Path $resolvedProjectRoot 'release-geumcheon')).Path
$outputRoot = Join-Path $resolvedProjectRoot 'Codex\Outputs\R6_v2'
$outputZip = Join-Path $outputRoot 'R6_NAS_CLIENT_RELEASE.zip'
$supersededRoot = Join-Path $resolvedProjectRoot 'Codex\Artifacts\R6_v2\Superseded_Packaging'
if ($sourceRoot -ne (Join-Path $resolvedProjectRoot 'release-geumcheon')) { throw 'SOURCE_PATH_UNSAFE' }
if ((Split-Path -Parent $outputZip) -ne $outputRoot) { throw 'OUTPUT_PATH_UNSAFE' }
New-Item -ItemType Directory -Force -Path $outputRoot, $supersededRoot | Out-Null
if (Test-Path -LiteralPath $outputZip) {
  $stream = [System.IO.File]::OpenRead($outputZip)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha256.Dispose() }
  } finally { $stream.Dispose() }
  $hashPrefix = $hash.Substring(0, 12)
  $baseName = "R6_NAS_CLIENT_RELEASE_superseded_$hashPrefix"
  $supersededZip = Join-Path $supersededRoot "$baseName.zip"
  $suffix = 2
  while (Test-Path -LiteralPath $supersededZip) {
    $supersededZip = Join-Path $supersededRoot "${baseName}_$suffix.zip"
    $suffix += 1
  }
  Move-Item -LiteralPath $outputZip -Destination $supersededZip
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
try {
  [System.IO.Compression.ZipFile]::CreateFromDirectory($sourceRoot, $outputZip, [System.IO.Compression.CompressionLevel]::Optimal, $false, [System.Text.Encoding]::UTF8)
} catch {
  if (Test-Path -LiteralPath $outputZip) { Remove-Item -LiteralPath $outputZip -Force }
  throw
}
Write-Output $outputZip
if ($null -ne $supersededZip) { Write-Output $supersededZip }
