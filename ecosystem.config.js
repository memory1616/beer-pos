module.exports = {
  apps: [
    {
      name: 'beerpos-local',
      script: 'node',
      args: 'server.js',
      cwd: '.',
      env: {
        PORT: 3000,
        HOST: '0.0.0.0'
      },
      watch: false,
      autorestart: true,
      restart_delay: 1000,
      windowsHide: true,
      out_file: './src/logs/local-out.log',
      error_file: './src/logs/local-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    },
    {
      name: 'beerpos-cloud',
      script: 'node',
      args: 'server.js',
      cwd: '.',
      env: {
        PORT: 3001,
        HOST: '0.0.0.0'
      },
      watch: false,
      autorestart: true,
      restart_delay: 1000,
      windowsHide: true,
      out_file: './src/logs/cloud-out.log',
      error_file: './src/logs/cloud-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true
    }
  ]
};
