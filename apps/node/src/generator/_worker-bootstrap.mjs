// Dev-only bootstrap: Node's --import/--require flags don't reliably propagate the
// tsx loader into Worker threads, so we register it programmatically before
// importing thread.ts. The production build (tsc) loads thread.js directly and
// never touches this file.
import { register } from 'tsx/esm/api';

register();
await import('./thread.ts');
