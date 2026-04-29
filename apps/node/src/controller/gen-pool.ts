import type { CtlMsg } from '@hammr/shared';

export interface GeneratorEntry {
  generatorId: string;
  cores: number;
  maxVUs: number;
  registeredAt: number;
  // Sends a control message over the underlying WS. Throws synchronously only
  // if the socket is already in a non-OPEN state; transient send failures are
  // surfaced via the WS server's error/close listeners, not here.
  send(msg: CtlMsg): void;
  // Severs the WS connection. Used when the controller wants to evict a gen.
  disconnect(reason?: string): void;
}

// Registry of generators currently connected to the controller. The WS server
// owns each socket and adds/removes entries here on connect/disconnect.
//
// Why a separate registry (vs. iterating ws.clients)? It keeps the orchestrator
// decoupled from the transport — orchestrator picks gens by capacity and calls
// send() without ever touching WebSocket.
export class GeneratorPool {
  private readonly gens = new Map<string, GeneratorEntry>();
  private readonly listeners = new Set<(ev: PoolEvent) => void>();

  add(entry: GeneratorEntry): void {
    if (this.gens.has(entry.generatorId)) {
      // Same id reconnecting (e.g. after a brief network blip). Replace the
      // entry so future sends use the fresh socket.
      this.gens.set(entry.generatorId, entry);
      this.emit({ type: 'reconnected', generatorId: entry.generatorId });
      return;
    }
    this.gens.set(entry.generatorId, entry);
    this.emit({ type: 'registered', generatorId: entry.generatorId });
  }

  remove(generatorId: string): void {
    if (!this.gens.delete(generatorId)) return;
    this.emit({ type: 'disconnected', generatorId });
  }

  get(generatorId: string): GeneratorEntry | undefined {
    return this.gens.get(generatorId);
  }

  list(): GeneratorEntry[] {
    return Array.from(this.gens.values());
  }

  size(): number {
    return this.gens.size;
  }

  on(listener: (ev: PoolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: PoolEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // Listener errors must not break the pool.
      }
    }
  }
}

export type PoolEvent =
  | { type: 'registered'; generatorId: string }
  | { type: 'reconnected'; generatorId: string }
  | { type: 'disconnected'; generatorId: string };
