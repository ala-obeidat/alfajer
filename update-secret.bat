@echo off
REM Alfajer TURN secret rotator (Windows-side).
REM
REM Configuration: read from deploy-secrets.local.txt (gitignored). Expected lines:
REM   SERVER_IP=<your server ip>
REM   SERVER_USER=root
REM   SSH_KEY_PATH=C:\path\to\private\key
REM   TURN_STATIC_AUTH_SECRET=<current secret, will be replaced>
REM
REM What it does:
REM   1. Generates a fresh 64-char hex secret via Windows' cryptographic RNG.
REM   2. SCPs update-secret.sh to the server.
REM   3. Pipes the new secret to ssh stdin so the server-side script reads it
REM      — never appears in any process listing.
REM   4. On server success, rewrites deploy-secrets.local.txt locally.
REM   5. On any failure, the local file is left untouched.

setlocal EnableDelayedExpansion

set SCRIPT_DIR=%~dp0
set LOCAL_SECRETS=%SCRIPT_DIR%deploy-secrets.local.txt
set TMP_SECRET=%TEMP%\alfajer-newsecret.tmp

REM Parse the local secrets file into env vars.
if not exist "%LOCAL_SECRETS%" (
    echo ERROR: %LOCAL_SECRETS% not found.
    echo Create it with at minimum:
    echo   SERVER_IP=...
    echo   SERVER_USER=root
    echo   SSH_KEY_PATH=C:\path\to\private\key
    echo   TURN_STATIC_AUTH_SECRET=...
    exit /b 1
)

set SERVER_IP=
set SERVER_USER=
set SSH_KEY=
for /f "usebackq tokens=1,* delims==" %%a in ("%LOCAL_SECRETS%") do (
    if /i "%%a"=="SERVER_IP" set SERVER_IP=%%b
    if /i "%%a"=="SERVER_USER" set SERVER_USER=%%b
    if /i "%%a"=="SSH_KEY_PATH" set SSH_KEY=%%b
)
if "%SERVER_USER%"=="" set SERVER_USER=root

if "%SERVER_IP%"=="" (
    echo ERROR: SERVER_IP missing from %LOCAL_SECRETS%
    exit /b 1
)
if "%SSH_KEY%"=="" (
    echo ERROR: SSH_KEY_PATH missing from %LOCAL_SECRETS%
    exit /b 1
)
if not exist "%SSH_KEY%" (
    echo ERROR: SSH key file not found at %SSH_KEY%
    exit /b 1
)
if not exist "%SCRIPT_DIR%update-secret.sh" (
    echo ERROR: update-secret.sh not found next to update-secret.bat
    exit /b 1
)

echo === Alfajer TURN secret rotation ===
echo Target: %SERVER_USER%@%SERVER_IP%
echo.

echo [1/4] Generating new 64-char hex secret...
powershell -NoProfile -Command "$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $hex = -join ($b ^| ForEach-Object { $_.ToString('x2') }); [IO.File]::WriteAllText('%TMP_SECRET%', $hex)"
if errorlevel 1 (
    echo ERROR: PowerShell secret generation failed
    if exist "%TMP_SECRET%" del "%TMP_SECRET%"
    exit /b 1
)

set /p NEW_SECRET=<"%TMP_SECRET%"
del "%TMP_SECRET%"
if "%NEW_SECRET%"=="" (
    echo ERROR: Generated secret is empty
    exit /b 1
)

set MASKED_PREFIX=!NEW_SECRET:~0,6!
set MASKED_SUFFIX=!NEW_SECRET:~-6!
echo       new secret: !MASKED_PREFIX!...!MASKED_SUFFIX!

echo.
echo [2/4] Copying server-side script to /root/update-secret.sh...
scp -i "%SSH_KEY%" -o StrictHostKeyChecking=accept-new "%SCRIPT_DIR%update-secret.sh" %SERVER_USER%@%SERVER_IP%:/root/update-secret.sh
if errorlevel 1 (
    echo ERROR: scp failed.
    goto fail
)

echo.
echo [3/4] Applying new secret on server ^(restarts coturn + signaling^)...
echo !NEW_SECRET!| ssh -i "%SSH_KEY%" %SERVER_USER%@%SERVER_IP% "bash /root/update-secret.sh"
if errorlevel 1 (
    echo.
    echo ERROR: Server-side rotation failed. Check output above.
    goto fail
)

echo.
echo [4/4] Rewriting local %LOCAL_SECRETS%...
powershell -NoProfile -Command "$c = Get-Content '%LOCAL_SECRETS%'; $c = $c -replace '^TURN_STATIC_AUTH_SECRET=.*', 'TURN_STATIC_AUTH_SECRET=!NEW_SECRET!'; Set-Content -NoNewline -Path '%LOCAL_SECRETS%' -Value ($c -join [Environment]::NewLine)"
if errorlevel 1 (
    echo WARNING: Local file update failed, but server is already on the new secret.
    echo Manually edit %LOCAL_SECRETS% and set TURN_STATIC_AUTH_SECRET=!NEW_SECRET!
    exit /b 1
)

echo.
echo === SUCCESS ===
echo The new secret is now live on the server and in your local config.
echo Previous values backed up at /root/alfajer-secret-backups/ on the server.
echo Next rotation due in 90 days.
exit /b 0

:fail
echo.
echo Local deploy-secrets.local.txt was NOT modified.
echo Verify server state with:
echo   ssh -i "%SSH_KEY%" %SERVER_USER%@%SERVER_IP% "grep static-auth-secret /etc/turnserver.conf"
echo   ssh -i "%SSH_KEY%" %SERVER_USER%@%SERVER_IP% "grep TURN_STATIC_AUTH_SECRET /root/alfajer/apps/signaling/.env"
exit /b 1
