import type { GatewayEvent } from "../shared/types.js";

export type { GatewayEvent };

export interface StoredEvent {
  id: number;
  event: GatewayEvent;
}

type Listener = (stored: StoredEvent) => void;

/**
 * 表示「现在是什么样」的事件：只在变化时发一次，后来的事件不会再带上。
 * 一轮跑得久（每一小段输出都是一条 stream_event），开始时那条 state: running 早被挤出缓冲，
 * 这时打开、切回这个会话从头订阅，回放里就没有它，网页一直当这一轮没在运行（没有「停止」按钮）
 */
const STICKY_TYPES = new Set<GatewayEvent["type"]>(["state", "desktop_target", "context"]);

/** 一个会话的事件频道：环形缓冲 + 订阅；状态类事件另外记着最后一条，见 latestSticky */
class Channel {
  private buffer: StoredEvent[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();
  private sticky = new Map<GatewayEvent["type"], StoredEvent>();

  constructor(private readonly capacity: number) {}

  publish(event: GatewayEvent): void {
    const stored = { id: this.nextId++, event };
    this.buffer.push(stored);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    if (STICKY_TYPES.has(event.type)) this.sticky.set(event.type, stored);
    for (const listener of this.listeners) listener(stored);
  }

  /**
   * 订阅方没收到过、回放里也没有（已经挤出缓冲）的状态类事件，按发出的顺序：回放之前先补发，让它知道现在的状态。
   * seenUpTo 是订阅方已经收到的最后一条的 id（从头订阅、续不上重来时是 0），replayFrom 是这次回放的第一条的 id
   */
  missingSticky(seenUpTo: number, replayFrom: number): GatewayEvent[] {
    return [...this.sticky.values()]
      .filter((s) => s.id > seenUpTo && s.id < replayFrom)
      .sort((a, b) => a.id - b.id)
      .map((s) => s.event);
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

  /** 会话删除后丢掉它的事件缓冲 */
  remove(sessionId: string): void {
    this.channels.delete(sessionId);
  }
}
