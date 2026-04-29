// Dev-only proxy: the dashboard runs on :3002 and forwards REST + Socket.IO
// to the controller on :3000. In prod the same origin fronts both, so these
// rewrites become inert.
//
// CONTROLLER_ORIGIN is read at *build* time (so it bakes into the dev server's
// rewrite rules) and defaults to the local controller. Override via env when
// pointing the dashboard at a remote controller.
const CONTROLLER_ORIGIN = process.env.CONTROLLER_ORIGIN ?? 'http://localhost:3000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Bundles the workspace package directly instead of expecting a built
  // dist/. Lets the web app pick up shared schema edits without a rebuild.
  transpilePackages: ['@hammr/shared'],
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${CONTROLLER_ORIGIN}/api/:path*` },
      { source: '/socket.io/:path*', destination: `${CONTROLLER_ORIGIN}/socket.io/:path*` },
    ];
  },
};

export default nextConfig;
