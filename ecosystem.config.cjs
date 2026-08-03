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
      // V8's heap is not capped here by default — the "32 MB" you see on the
      // Metrics page is just how much heap V8 has currently allocated for an
      // idle process, not a ceiling; it grows on demand (with GC pauses as it
      // does) up to V8's own default limit, which itself scales off the host's
      // RAM. This sets an explicit floor/ceiling instead of trusting that
      // default: 4GB of heap headroom on this 31.3GB host, comfortably under
      // the 8G RSS restart cap above (heap is a subset of RSS — native buffers
      // for gzip/tar/mongodb driver sit outside it, so heap shouldn't be set
      // anywhere near the RSS cap).
      node_args: '--max-old-space-size=4096',
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
