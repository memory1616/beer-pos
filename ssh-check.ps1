$pass = ConvertTo-SecureString "Zxcv@1234" -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ("root", $pass)
$result = Invoke-Command -ComputerName "103.75.183.57" -Credential $cred -ScriptBlock {
    cd ~/beer-pos
    Write-Host "=== PWD ==="
    pwd
    Write-Host "=== FILES ==="
    ls -la
    Write-Host "=== RECENT SALES ==="
    sqlite3 database.sqlite "SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 20;"
    Write-Host "=== TODAY SALES ==="
    sqlite3 database.sqlite "SELECT COUNT(*) as count FROM sales WHERE date(date) = date('now', 'localtime') AND type = 'sale';"
}
$result
