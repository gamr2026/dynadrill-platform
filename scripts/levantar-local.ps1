# Levanta todo el entorno local de Dynadrill: infraestructura (Docker), contenedores nuevos, demo, gateway y frontend.
#   powershell -ExecutionPolicy Bypass -File dynadrill-platform\scripts\levantar-local.ps1
# Requisitos: Docker Desktop abierto y los builds hechos (npx nx run-many -t build; npm run build en dynadrill-backend).
# No imprime ni guarda secretos: el secreto del puente con la demo se lee de dynadrill-backend\.env al arrancar.

$ErrorActionPreference = 'Stop'
$raiz = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
if (-not (Test-Path "$raiz\dynadrill-platform")) { $raiz = 'C:\Users\Digitec\Documents\proyectos' }
$plat = "$raiz\dynadrill-platform"
$demo = "$raiz\dynadrill-backend"
$front = "$raiz\dynadrill\dynadrill-frontend-platform"

function Esperar-Docker {
  for ($i = 0; $i -lt 60; $i++) {
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return }
    Start-Sleep 3
  }
  throw 'Docker no respondió: abra Docker Desktop y vuelva a intentar.'
}

Write-Host '1/5 Infraestructura (Postgres, PgBouncer, RabbitMQ, Azurite, OCR de firmas)...'
Esperar-Docker
docker compose -f "$plat\infra\docker-compose.yml" --profile ocr up -d

Write-Host '2/5 Contenedores nuevos (plataforma 3101, comercial 3102, operaciones 3103)...'
foreach ($app in 'plataforma', 'comercial', 'operaciones') {
  Start-Process node -ArgumentList "dist/apps/$app/main.js" -WorkingDirectory $plat -WindowStyle Hidden
}

Write-Host '3/5 Demo (3300)...'
$env:PORT = '3300'
Start-Process node -ArgumentList 'dist/apps/api-gateway/apps/api-gateway/src/main.js' -WorkingDirectory $demo -WindowStyle Hidden
Remove-Item Env:PORT

Write-Host '4/5 Gateway (3100)...'
$secreto = (Get-Content "$demo\.env" | Where-Object { $_ -match '^JWT_SECRET=' }) -replace '^JWT_SECRET=', ''
$env:LEGACY_URL = 'http://localhost:3300'
$env:PLATAFORMA_URL = 'http://localhost:3101'
$env:COMERCIAL_URL = 'http://localhost:3102'
$env:OPERACIONES_URL = 'http://localhost:3103'
$env:LEGACY_JWT_SECRET = $secreto.Trim('"')
Start-Process node -ArgumentList 'dist/apps/gateway/main.js' -WorkingDirectory $plat -WindowStyle Hidden
Remove-Item Env:LEGACY_JWT_SECRET

Write-Host '5/5 Frontend (4200)...'
Start-Process cmd -ArgumentList '/c', 'npm start' -WorkingDirectory $front -WindowStyle Hidden

Start-Sleep 30
$puertos = [ordered]@{ 3100 = 'gateway'; 3101 = 'plataforma'; 3102 = 'comercial'; 3103 = 'operaciones'; 3300 = 'demo'; 4200 = 'frontend'; 8090 = 'firmas-ocr' }
foreach ($k in $puertos.Keys) {
  '{0,-12} {1,-6} {2}' -f $puertos[$k], $k, $(if (Get-NetTCPConnection -LocalPort $k -State Listen -ErrorAction SilentlyContinue) { 'arriba' } else { 'CAIDO (espere unos segundos y revise)' })
}
Write-Host 'Abra http://localhost:4200'
