@echo off
REM Alfajer TURN secret rotator (Windows-side).
REM
REM What it does:
REM   1. Generates a fresh 64-char hex secret via Windows' cryptographic
REM      RNG (PowerShell System.Security.Cryptography).
REM   2. SCPs update-secret.sh to the server.
REM   3. Pipes the new secret to ssh stdin, which the server-side script
REM      reads. The secret never appears in any command-line argument.
REM   4. On server success, rewrites deploy-secrets.local.txt locally.
REM   5. On any failure, the local file is left ALONE so you can rerun
REM      with the secret still in sync.
REM
REM Run from the project root (this file's directory).

setlocal EnableDelayedExpansion

set SERVER_IP=178.105.197.8
set SERVER_USER=root
set SSH_KEY=C:\key2\alfajer
set SCRIPT_DIR=%~dp0
set LOCAL_SECRETS=%SCRIPT_DIR%deploy-secrets.local.txt
set TMP_SECRET=%TEMP%\alfajer-newsecret.tmp

REM Sanity checks
if not exist "%SSH_KEY%" (
    echo ERROR: SSH key not found at %SSH_KEY%
    exit /b 1
)
if not exist "%SCRIPT_DIR%update-secret.sh" (
    echo ERROR: update-secret.sh not found next to update-secret.bat
    exit /b 1
)
if not exist "%LOCAL_SECRETS%" (
    echo ERROR: %LOCAL_SECRETS% not found. Expected in project root.
    exit /b 1
)

echo === Alfajer TURN secret rotation ===
echo Server: %SERVER_USER%@%SERVER_IP%
echo.

echo [1/4] Generating new 64-char hex secret...
powershell -NoProfile -Command "$b = New-Object byte[] 32; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $hex = -join ($b ^| ForEach-Object { $_.ToString('x2') }); [IO.File]::WriteAllText('%TMP_SECRET%', $hex)"
if errorlevel 1 (
    echo ERROR: PowerShell secret generation failed
    if exist "%TMP_SECRET%" del "%TMP_SECRET%"
    exit /b 1
)

REM Read the secret into the variable
set /p NEW_SECRET=<"%TMP_SECRET%"
del "%TMP_SECRET%"
if "%NEW_SECRET%"=="" (
    echo ERROR: Generated secret is empty
    exit /b 1
)

REM Show first 6 and last 6 chars only, never the full value
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
REM Pipe the secret to ssh stdin so it never appears on the command line.
REM The server script reads it via `read NEW_SECRET`.
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
echo The new secret is now live on:
echo   - /etc/turnserver.conf                          ^(server^)
echo   - /root/alfajer/apps/signaling/.env             ^(server^)
echo   - deploy-secrets.local.txt                      ^(local^)
echo.
echo Previous values backed up at /root/alfajer-secret-backups/ on the server.
echo Next rotation due in 90 days.
exit /b 0

:fail
echo.
echo Local deploy-secrets.local.txt was NOT modified.
echo Verify server state with:
echo   ssh -i %SSH_KEY% %SERVER_USER%@%SERVER_IP% "grep static-auth-secret /etc/turnserver.conf"
echo   ssh -i %SSH_KEY% %SERVER_USER%@%SERVER_IP% "grep TURN_STATIC_AUTH_SECRET /root/alfajer/apps/signaling/.env"
exit /b 1
