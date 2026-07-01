const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const command = `ssh -o ConnectTimeout=10 -i _server_rsa.pem root@103.75.183.57 "cd /root/beer-pos && git log -1 --oneline"`;

exec(command, { cwd: 'D:/Beer' }, (error, stdout, stderr) => {
  console.log('Server git commit:', stdout || stderr);
});

// Also check local commit
const localCommit = execSync('git log -1 --oneline', { cwd: 'D:/Beer' });
console.log('Local git commit:', localCommit);
