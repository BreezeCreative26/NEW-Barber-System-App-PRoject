module.exports = {
  apps: [
    {
      name: "barbershop-preview",
      cwd: "/home/user/webapp",
      script: "node_modules/wrangler/bin/wrangler.js",
      args: "pages dev dist --ip 0.0.0.0 --port 3000",
      interpreter: "node",
      env: {
        NODE_ENV: "development",
        PORT: "3000",
        WRANGLER_SEND_METRICS: "false",
      },
      watch: false,
      instances: 1,
      exec_mode: "fork",
    },
  ],
};
