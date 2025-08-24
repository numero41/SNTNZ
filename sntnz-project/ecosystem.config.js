module.exports = {
  apps: [
    {
      name: "sntnz",
      script: "server.js",
      env: {
        NODE_ENV: "production",
        TRUST_PROXY: "1",
        CORS_ORIGIN: "https://www.sntnz.com"
      },
      instances: 1,              // set >1 later with a Redis adapter
      exec_mode: "fork",         // or "cluster" when we’re ready
      max_memory_restart: "300M",
      kill_timeout: 10000,       // give time for graceful shutdown
      listen_timeout: 10000,
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      merge_logs: true
    }
  ]
}
