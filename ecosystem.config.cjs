module.exports = {
  apps: [{
    name: 'music-tool',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}
