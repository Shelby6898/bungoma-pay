module.exports = {
  apps: [{
    name: "bungoma-pay",
    script: "server.js",
    cwd: __dirname,
    time: true,
    min_uptime: "10s",
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: "production"
    }
  }]
}
