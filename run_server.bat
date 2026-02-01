@echo off
setlocal

cd /d "%~dp0"

if not exist ".venv" (
    echo [i] Creating virtual environment...
    python -m venv .venv || goto :error
)

call .venv\Scripts\activate.bat || goto :error

pip install --upgrade pip >nul
pip install -r requirements.txt || goto :error

echo [i] Starting LM Studio + Kokoro server...
start "" powershell -NoProfile -Command "while (-not (try { $client = New-Object System.Net.Sockets.TcpClient; $client.Connect('localhost',5000); $client.Dispose(); $true } catch { $false })) { Start-Sleep -Seconds 1 }; Start-Process 'http://localhost:5000'"
python server.py
goto :eof

:error
echo [!] Failed to start server.
exit /b 1
