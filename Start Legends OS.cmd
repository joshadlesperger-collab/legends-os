@echo off
cd /d "%~dp0"
node -e "require('./lib/card-processing-v2-runtime-root.cjs').assertV2RuntimeRoot()" || exit /b 1
node node_modules/next/dist/bin/next start -p 3097
