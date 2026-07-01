const { Client } = require('ssh2');
const fs = require('fs');

const privateKey = fs.readFileSync('D:/Beer/cursor_deploy_key', 'utf8');

console.log('Deploying to server...');
console.log('Key starts with:', privateKey.substring(0, 60));

const conn = new Client();

conn.on('ready', () => {
  console.log('SSH Connected!');

  // Run deploy script on server
  const deployCmd = `
    cd ~/beer-pos && \
    echo "=== Current commit ===" && \
    git log --oneline -3 && \
    echo "" && \
    echo "=== Git pull ===" && \
    git pull origin main && \
    echo "" && \
    echo "=== New commit ===" && \
    git log --oneline -3 && \
    echo "" && \
    echo "=== Restart PM2 ===" && \
    pm2 restart beer-pos && \
    sleep 3 && \
    echo "" && \
    echo "=== PM2 Status ===" && \
    pm2 status && \
    echo "" && \
    echo "=== Health Check ===" && \
    curl -s http://127.0.0.1:3000/health || echo "Health check failed"
  `;

  conn.exec(deployCmd, (err, stream) => {
    if (err) {
      console.log('Exec error:', err.message);
      conn.end();
      return;
    }

    stream.on('data', d => process.stdout.write(d.toString()));
    stream.stderr.on('data', d => process.stderr.write(d.toString()));
    stream.on('close', (code) => {
      console.log('\nDeploy complete! Exit code:', code);
      conn.end();
      process.exit(code === 0 ? 0 : 1);
    });
  });
}).on('error', (err) => {
  console.log('SSH error:', err.message);
  process.exit(1);
}).on('debug', (message) => {
  console.log('SSH debug:', message);
}).connect({
  host: '103.75.183.57',
  port: 22,
  username: 'root',
  privateKey: privateKey,
  readyTimeout: 30000,
  debug: (message) => console.log('DEBUG:', message)
});
