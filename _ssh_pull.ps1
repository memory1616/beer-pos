$pass = ConvertTo-SecureString "Zxcv@1234" -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential("root", $pass)
$proc = Start-Process ssh -ArgumentList "-o StrictHostKeyChecking=no","-o ConnectTimeout=15","root@103.75.183.57","cd /root/Beer && pwd && git log --oneline -3 && git pull origin main 2>&1" -NoNewWindow -Wait -PassThru
exit $proc.ExitCode
