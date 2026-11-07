$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $runtimeRoot
node -e "require('./lib/card-processing-v2-runtime-root.cjs').assertV2RuntimeRoot()"
if ($LASTEXITCODE -ne 0) { throw 'Use the active local operational checkout.' }
$listener = Get-NetTCPConnection -LocalPort 3097 -State Listen -ErrorAction SilentlyContinue
if ($listener) { throw 'Port 3097 is already in use; inspect the existing process before starting another writer.' }
& node --experimental-strip-types scripts/card-processing-v2-background.ts recover
if ($LASTEXITCODE -ne 0) { Write-Warning 'Background recovery needs attention; the page will retain its checkpoint.' }
& node --experimental-strip-types scripts/card-processing-v2-identify-sort.ts --recover
if ($LASTEXITCODE -ne 0) { Write-Warning 'Identification recovery needs attention; saved originals remain protected.' }
& node node_modules/next/dist/bin/next start -p 3097
exit $LASTEXITCODE
