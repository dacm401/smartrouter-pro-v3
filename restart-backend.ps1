$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/smartrouter"
$env:NODE_ENV = "development"
$env:ALLOW_DEV_FALLBACK = "true"
$env:STORAGE_BACKEND = "local"
$env:LOCAL_ARCHIVE_PATH = "C:/Users/ligua/WorkBuddy/backend_real/data"
$env:JWT_SECRET = "dev-secret-for-testing-only-32chars!"
$env:JWT_ENABLED = "false"
$env:FAST_MODEL = "Qwen/Qwen2.5-7B-Instruct"
$env:SLOW_MODEL = "Qwen/Qwen2.5-72B-Instruct"
$env:OPENAI_API_KEY = "sk-iewslddrpfiwsqyctiiquktrwhubgvqyywspurlpbyonrdaf"
$env:OPENAI_BASE_URL = "https://api.siliconflow.cn/v1"

Set-Location "C:/Users/ligua/WorkBuddy/backend_real"

$outFile = "C:/Users/ligua/WorkBuddy/backend_real/backend-stdout.txt"
$errFile = "C:/Users/ligua/WorkBuddy/backend_real/backend-stderr.txt"

$proc = Start-Process -FilePath node -ArgumentList "dist/index.js" -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile -NoNewWindow

Write-Host "Backend PID: $($proc.Id)"
Start-Sleep -Seconds 6

Write-Host "=== STDOUT (last 50 lines) ==="
Get-Content $outFile -Encoding UTF8 -Tail 50

Write-Host ""
Write-Host "=== STDERR (last 30 lines) ==="
Get-Content $errFile -Encoding UTF8 -Tail 30
