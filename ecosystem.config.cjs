module.exports = {
  apps: [
    {
      name: 'back-me-up',
      script: 'src/server.js',
      instances: 1,
      // PM2 defaults to cluster mode whenever `instances` is set, even at 1 — that
      // spins the app up inside Node's cluster module with a PM2-managed load
      // balancer in front of the port, and a reload briefly runs two workers at
      // once for zero-downtime. This app keeps change-stream capture workers and
      // cron schedules in a plain in-process Map (captureManager.js,
      // schedulerManager.js) with no cross-process coordination, so two workers
      // running even briefly means two processes independently watching the same
      // change streams and both eligible to fire the same scheduled backup —
      // duplicate/racing writes, not just wasted CPU. Force fork mode.
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Restart-on-leak safety net, not a usage ceiling: the deploy host has 31.3GB,
      // so this leaves headroom for the catalog Mongo container, nginx and the OS
      // while still catching a real leak long before it takes the box down.
      // mongodump/mongorestore run as separate child processes (mongoTools.js) and
      // don't count against this — it's just this Node process's own RSS.
      max_memory_restart: '8G',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
