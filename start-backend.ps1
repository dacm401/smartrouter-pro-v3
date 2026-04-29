$ErrorActionPreference = "Stop"
$env:OPENAI_API_KEY = "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"
$env:OPENAI_BASE_URL = "https://openrouter.ai/api/v1"
$env:FAST_MODEL = "qwen/qwen-2.5-72b-instruct"
$env:SLOW_MODEL = "qwen/qwen-2.5-72b-instruct"
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/smartrouter"
$env:JWT_SECRET = "SmartRouterPro2026ProductionSecretKey32chars"
$env:NODE_ENV = "development"

cd C:\Users\ligua\WorkBuddy\backend_real
node dist\index.js
