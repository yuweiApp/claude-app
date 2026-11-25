import { useEffect, useRef, useSyncExternalStore } from "react";
import { api, type SessionListItem } from "./api";
import { sessionTitle } from "./components/Sidebar";
import { desktop } from "./desktop";

/**
 * 灵宠（桌面版）：屏幕角落的小精灵，主窗口不在前台时告诉用户会话完成了，见 desktop/src/pet.ts。
 * 开关记在 localStorage，默认开；关掉时只存 "off"
 */
const KEY = "pet";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let enabled = read();

export function setPetEnabled(value: boolean) {
  enabled = value;
  try {
    if (value) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    // 存不了时只在本次打开期间生效
  }
  listeners.forEach((l) => l());
}

export function usePetEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => enabled,
  );
}

/** 灵宠眼里的「在跑」：一轮没结束，或者一轮结束了后台任务还在跑（结束时会再唤起一轮）。模型开的终端里的命令（如开发服务器）不算 */
const busy = (s: SessionListItem) => s.state === "running" || (s.state === "idle" && !!s.tasksRunning);

/**
 * 按会话列表的变化告诉外壳：在跑的会话数，以及哪个会话从在跑变成了空闲（完成）。
 * 主窗口最小化期间外壳定时发 tick，这里刷新列表；用户点灵宠时打开那个会话
 */
export function usePet(sessions: SessionListItem[], refresh: () => void, open: (sessionId: string) => void) {
  const on = usePetEnabled();
  const pet = desktop?.pet;
  const working = sessions.filter(busy).length;

  useEffect(() => pet?.update({ enabled: on, working }), [pet, on, working]);

  const before = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    const now = new Map(sessions.map((s) => [s.sessionId, busy(s)]));
    const prev = before.current;
    // 列表还没拉到过（空列表）时不算：刚打开时已经停下的会话不报
    before.current = sessions.length || prev ? now : null;
    if (!prev || !on || !pet) return;
    for (const s of sessions) {
      if (prev.get(s.sessionId) && !now.get(s.sessionId) && s.state === "idle") pet.notify({ sessionId: s.sessionId, title: sessionTitle(s) });
    }
  }, [sessions, on, pet]);

  useEffect(() => pet?.onTick(refresh), [pet, refresh]);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // 鼠标悬停在灵宠上时，外壳定时发 pet:peek，这里按在跑的会话列表向网关取最新回复推回去
  useEffect(() => {
    if (!pet?.onPeek || !pet?.setLive) return;
    let inFlight = false;
    return pet.onPeek(() => {
      if (inFlight) return;
      const active = sessionsRef.current.filter(busy);
      if (!active.length) {
        pet.setLive?.([]);
        return;
      }
      inFlight = true;
      void api
        .liveReplies(active.map((s) => s.sessionId))
        .then(({ replies }) => {
          const byId = new Map(replies.map((r) => [r.sessionId, r]));
          pet.setLive?.(
            active.map((s) => {
              const r = byId.get(s.sessionId);
              return {
                sessionId: s.sessionId,
                title: sessionTitle(s),
                text: r?.text ?? "",
                activity: r?.activity ?? "正在处理",
                startedAt: r?.startedAt ?? 0,
              };
            }),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    });
  }, [pet]);

  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => pet?.onOpen((id) => openRef.current(id)), [pet]);
  useEffect(() => pet?.onDisabled(() => setPetEnabled(false)), [pet]);
}
