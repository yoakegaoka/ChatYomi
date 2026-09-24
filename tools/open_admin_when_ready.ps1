param(
    [string]$HealthUrl = 'http://127.0.0.1:8080/health',
    [string]$AdminUrl = 'http://127.0.0.1:8080/admin',
    [int]$TimeoutSec = 240
)

$ErrorActionPreference = 'SilentlyContinue'
for ($i = 0; $i -lt ($TimeoutSec * 2); $i++) {
    try {
        $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2
        if ($health.status -eq 'ok') {
            Start-Process $AdminUrl
            exit 0
        }
    }
    catch { }
    Start-Sleep -Milliseconds 500
}
exit 1
