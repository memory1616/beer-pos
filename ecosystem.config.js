// BeerPOS PM2 Ecosystem Configuration
module.exports = {
  apps: [
    {
      name: 'beerpos-local',
      script: './server.js',
      cwd: './',
      env: {
        PORT: 3000,
        HOST: '0.0.0.0',
        NODE_ENV: 'production'
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M'
    },
    {
      name: 'beerpos-cloud',
      script: './server.js',
      cwd: './',
      env: {
        PORT: 3001,
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
        IS_CLOUD_SERVER: 'true',
        CLOUD_MODE: 'true'
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M'
    }
  ]
};
