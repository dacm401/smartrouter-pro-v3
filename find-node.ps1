Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*dist/index.js*' } | ForEach-Object {
    Write-Host 'PID:' $_.ProcessId 'STARTED:' $_.CreationDate
    Write-Host 'CMD:' $_.CommandLine.Substring(0, 120)
}
