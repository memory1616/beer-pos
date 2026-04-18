$cmd = 'cd ~/beer-pos && pwd && ls -la && echo "=== SALES ===" && sqlite3 database.sqlite "SELECT id, date, total, type FROM sales ORDER BY id DESC LIMIT 15;" && echo "=== TODAY ===" && sqlite3 database.sqlite "SELECT COUNT(*) as today_count FROM sales WHERE date(date) = date('"'"'now'"'"', '"'"'+7 hours'"'"') AND type = '"'"'sale'"'"';"'
Start-Process -FilePath "C:\Windows\System32\OpenSSH\ssh.exe" -ArgumentList "-o StrictHostKeyChecking=no", "root@103.75.183.57", $cmd -NoNewWindow -Wait -RedirectStandardInput "D:\Beer\pass.txt" -RedirectStandardOutput "D:\Beer\ssh_output.txt" -RedirectStandardError "D:\Beer\ssh_error.txt"
Get-Content "D:\Beer\ssh_output.txt"
Get-Content "D:\Beer\ssh_error.txt"
