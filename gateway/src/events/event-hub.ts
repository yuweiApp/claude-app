import type { GatewayEvent } from "../shared/types.js";

export type { GatewayEvent };

export interface StoredEvent {
  id: number;
  event: GatewayEvent;
}

type Listener = (stored: StoredEvent) => void;

/** 一个会话的事件频道：环形缓冲 + 订阅 */
class Channel {
  private buffer: StoredEvent[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();

  constructor(private readonly capacity: number) {}

  publish(event: GatewayEvent): void {
    const stored = { id: this.nextId++, event };
    this.buffer.push(stored);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const listener of this.listeners) listener(stored);
  }

  /**
   * 回放 afterId 之后的事件。续不上时返回 null，调用方应发 reset 再回放整个缓冲：
   * afterId 之后的第一条已经被挤出缓冲；或者 afterId 比发出过的都大（网关重启过，id 从 1 重新数）
   */
  since(afterId: number): StoredEvent[] | null {
    const first = this.buffer[0];
    if (afterId >= this.nextId) return null;
    if (first && afterId > 0 && afterId < first.id - 1) return null;
    return this.buffer.filter((e) => e.id > afterId);
  }

  all(): StoredEvent[] {
    return [...this.buffer];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export class EventHub {
  private channels = new Map<string, Channel>();

  constructor(private readonly capacity: number) {}

  channel(sessionId: string): Channel {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = new Channel(this.capacity);
      this.channels.set(sessionId, channel);
    }
    return channel;
  }

  publish(sessionId: string, event: GatewayEvent): void {
    this.channel(sessionId).publish(event);
  }
}
