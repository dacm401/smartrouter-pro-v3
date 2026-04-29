Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
    $cmd = $_.CommandLine
    if ($cmd -like '*dist/index.js*') {
        [PSCustomObject]@{
            Id = $_.ProcessId
            StartTime = $_.CreationDate
            CommandLine = $cmd.Substring(0, [Math]::Min(140, $cmd.Length))
        }
    }
} | Format-Table -AutoSize
