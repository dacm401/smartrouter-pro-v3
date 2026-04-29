try {
    $r = Invoke-WebRequest -Uri 'https://www.siliconflow.com' -TimeoutSec 8 -UseBasicParsing
    Write-Host "Status: $($r.StatusCode)"
    Write-Host "Final URL: $($r.BaseResponse.ResponseUri)"
    Write-Host "Content Length: $($r.Content.Length)"
    Write-Host "Title: $(($r.Content -replace '<[^>]+>','') -replace '\s+',' ' | Select-Object -First 1)"
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
}
