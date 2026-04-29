'use client';
import { io, type Socket } from 'socket.io-client';

let cached: Socket | null = null;

// One Socket.IO connection per browser tab — shared across hook instances.
// The dashboard only watches one test at a time (single-test invariant lives
// on the controller too), so per-test sockets would be wasteful.
//
// Why a direct origin instead of going through the Next.js dev proxy:
// next.config.mjs's rewrites() handle plain HTTP, not WebSocket upgrades, so
// Socket.IO would silently downgrade to long-polling through the proxy. We
// dial the controller's public origin directly; CORS is enabled controller-
// side ({ origin: '*' }). In prod the same origin fronts both, so leaving
// NEXT_PUBLIC_CONTROLLER_ORIGIN unset gives a same-origin connection.
function originFor(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const fromEnv = process.env.NEXT_PUBLIC_CONTROLLER_ORIGIN;
  if (fromEnv) return fromEnv;
  // Same-origin: passing undefined to io() makes socket.io use window.location.
  return undefined;
}

export function getSocket(): Socket {
  if (cached) return cached;
  const origin = originFor();
  cached = origin
    ? io(origin, { path: '/socket.io', transports: ['websocket', 'polling'] })
    : io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  return cached;
}
