module.exports = {
  apps: [
    {
      name: 'back-me-up',
      script: 'src/server.js',
      instances: 1,
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
