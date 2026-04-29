try {
    $r = Invoke-WebRequest -Uri 'http://localhost:3001/api/chat' -Method POST -Body '{}' -ContentType 'application/json' -TimeoutSec 5
    Write-Host 'HTTP' $r.StatusCode
} catch {
    $s = $_.Exception.Response.StatusCode
    Write-Host 'HTTP' $s
}
