<#
.SYNOPSIS
  Confirma SOLO las rutas de un módulo en la rama `modulo/<modulo>` sin cambiar la rama del árbol de trabajo compartido.

.DESCRIPTION
  Varias sesiones trabajan en la misma copia del repositorio. Un `git add -A` o un `prettier --write` sobre carpetas ajenas mezcla el
  trabajo de otras sesiones. Este script usa un índice temporal: parte de la rama del módulo (o, la primera vez, de `HEAD`), agrega
  únicamente las rutas indicadas (nuevas, cambiadas o borradas), les da formato con Prettier, valida el mensaje con commitlint y crea el
  commit en `refs/heads/modulo/<modulo>`. Nada más cambia: ni el índice real, ni la rama actual, ni los archivos de otras sesiones.

.EXAMPLE
  ./scripts/commit-modulo.ps1 -Modulo flota -Mensaje "feat(flota): inspeccion de vehiculos" `
    -Rutas libs/operaciones/flota -Subir
  # en el frontend (dynadrill-frontend-platform):
  ../dynadrill-platform/scripts/commit-modulo.ps1 -Modulo flota -Mensaje "feat(flota): ..." -Rutas src/app/features/flota -Subir -Remoto respaldo

.NOTES
  El mensaje sigue commitlint (conventional commits): asunto en minúscula, líneas del cuerpo de 100 caracteres como máximo. La
  atribución de la sesión se agrega sola al final. La sesión principal fusiona `modulo/<modulo>` en `desarrollo`.
#>
param(
  [Parameter(Mandatory = $true)][string]$Modulo,
  [Parameter(Mandatory = $true)][string]$Mensaje,
  [Parameter(Mandatory = $true)][string[]]$Rutas,
  [switch]$Subir,
  # Solo para la sesión principal: confirma en la rama actual (`desarrollo`) en vez de `modulo/<modulo>`, y deja el índice real al día solo en esas rutas.
  [switch]$EnRamaActual,
  # A dónde se sube: `origin` en el backend; en el frontend el repo de respaldo se llama `respaldo` (su `origin` es el de la demo: NUNCA).
  [string]$Remoto = 'origin'
)
# 'Continue': en PowerShell 5.1 un aviso de git por la salida de error (p. ej. el de CRLF) no debe cortar el script; los pasos que importan revisan $LASTEXITCODE
Set-Location (git rev-parse --show-toplevel)

$rama = if ($EnRamaActual) { git branch --show-current } else { "modulo/$Modulo" }
$atribucion = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'
$completo = "$Mensaje`n`n$atribucion"

# 1. el mensaje debe pasar commitlint (los hooks de git no corren con este método); se escribe sin BOM para que lo lea bien
$archivoMensaje = Join-Path $env:TEMP ('msg-' + [guid]::NewGuid().ToString('N') + '.txt')
[System.IO.File]::WriteAllText($archivoMensaje, $completo, (New-Object System.Text.UTF8Encoding($false)))
npx --no-install commitlint --edit $archivoMensaje
if ($LASTEXITCODE -ne 0) {
  Remove-Item $archivoMensaje -ErrorAction SilentlyContinue
  throw 'El mensaje no cumple commitlint: corrijalo y vuelva a intentarlo.'
}

# 2. formato solo a lo suyo (nunca a carpetas ajenas)
foreach ($r in $Rutas) {
  if (Test-Path $r) { npx --no-install prettier --write --ignore-unknown --log-level warn $r | Out-Null }
}

$indice = Join-Path $env:TEMP ("idx-$Modulo-" + [guid]::NewGuid().ToString('N'))
$anterior = $env:GIT_INDEX_FILE
try {
  $env:GIT_INDEX_FILE = $indice
  $padre = git rev-parse --verify --quiet "refs/heads/$rama"
  if (-not $padre) { $padre = git rev-parse HEAD }
  git read-tree $padre
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo leer la rama base.' }
  git add -A --ignore-errors -- $Rutas 2>$null
  $arbol = git write-tree
  if ($LASTEXITCODE -ne 0 -or -not $arbol) { throw 'No se pudo armar el árbol del commit.' }
  $arbolPadre = git rev-parse "$padre^{tree}"
  if ($arbol -eq $arbolPadre) {
    Write-Host "Sin cambios en esas rutas: no se creó ningún commit."
    return
  }
  $nuevo = git commit-tree $arbol -p $padre -F $archivoMensaje
  if ($LASTEXITCODE -ne 0 -or -not $nuevo) { throw 'No se pudo crear el commit.' }
  git update-ref "refs/heads/$rama" $nuevo
  if ($EnRamaActual) {
    # el índice real ve el commit nuevo como cambios por deshacer: se alinea solo en las rutas confirmadas
    $env:GIT_INDEX_FILE = $anterior
    git reset -q -- $Rutas
  }
  Write-Host "Commit $($nuevo.Substring(0, 7)) en $rama"
  if ($Subir) {
    if ($Remoto -eq 'origin' -and (git remote get-url origin) -match 'dynadrill-frontend(.git)?$') {
      throw 'El origin de este repositorio es el de la demo: use -Remoto respaldo.'
    }
    git push $Remoto $rama
  }
}
finally {
  if ($null -eq $anterior) { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue } else { $env:GIT_INDEX_FILE = $anterior }
  Remove-Item $indice, $archivoMensaje -ErrorAction SilentlyContinue
}
