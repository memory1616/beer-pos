# Create a script file for expect-like behavior
$scriptContent = @'
spawn ssh -o StrictHostKeyChecking=no root@103.75.183.57 "cd ~/beer-pos && pwd && ls -la && echo '---SALES---' && sqlite3 database.sqlite 'SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 20;' && echo '---TODAY---' && sqlite3 database.sqlite \"SELECT COUNT(*) FROM sales WHERE date(date) = date('now', 'localtime') AND type = 'sale';\""
expect "password:"
send "Zxcv@1234\r"
interact
'@

# Write expect script
Set-Content -Path "$env:TEMP\expect_script.txt" -Value $scriptContent

# Run with expect if available, otherwise just run SSH command
$expectPath = "C:\Program Files\Git\usr\bin\expect.exe"
if (Test-Path $expectPath) {
    & $expectPath "$env:TEMP\expect_script.txt"
} else {
    # Alternative: try using SSH with password via environment variable
    $env:SSH_ASKPASS = "$env:TEMP\ssh_askpass.ps1"
    $askpassContent = @'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('Enter SSH password', 'SSH', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Question)
'@
    Set-Content -Path $env:SSH_ASKPASS -Value $askpassContent
    
    # Try direct SSH with BatchMode (will fail but we can see output)
    & "C:\Windows\System32\OpenSSH\ssh.exe" -o StrictHostKeyChecking=no -o BatchMode=no root@103.75.183.57 "cd ~/beer-pos && ls -la && sqlite3 database.sqlite 'SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 10;'" 2>&1
}
