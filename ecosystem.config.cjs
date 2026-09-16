module.exports = {
  apps: [
    {
      name: "ollo",
      cwd: "/home/user/webapp",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      interpreter: "node",
      env: { NODE_ENV: "production", PORT: "3000" },
      watch: false,
      instances: 1,
      exec_mode: "fork",
    },
  ],
};
