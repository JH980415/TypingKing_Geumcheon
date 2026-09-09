param([Parameter(Mandatory)][string]$ManifestPath, [Parameter(Mandatory)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$entries = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$stream = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew)
try {
  $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true, [Text.Encoding]::UTF8)
  try {
    foreach ($item in $entries) {
      $entry = $zip.CreateEntry($item.name, [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [DateTimeOffset]::new(2026, 9, 9, 0, 0, 0, [TimeSpan]::Zero)
      $inputStream = [IO.File]::OpenRead($item.source)
      $outputStream = $entry.Open()
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
