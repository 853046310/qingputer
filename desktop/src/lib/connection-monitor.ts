/**
 * Connection health monitor with state machine, ping, and auto-reconnect.
 *
 * States: connected → reconnecting → connected | disconnected
 *         connected → offline (network down)
 *         offline   → reconnecting (network restored)
 */

import type { IRuntimeApi } from "./api-interface";

export type ConnectionState = "connected" | "reconnecting" | "disconnected" | "offline";

export interface ConnectionMonitorOptions {
  api: IRuntimeApi;
  mode: "lan" | "relay";
  pingIntervalMs?: number;
  maxReconnectAttempts?: number;
  onStateChange: (state: ConnectionState) => void;
  onReconnected: () => void;
}

const DEFAULT_PING_INTERVAL = 15_000;
const DEFAULT_MAX_RECONNECT = 10;
const PING_TIMEOUT = 5_000;

export class ConnectionMonitor {
  private api: IRuntimeApi;
  private mode: "lan" | "relay";
  private pingInterval: number;
  private maxReconnect: number;
  private onStateChange: (state: ConnectionState) => void;
  private onReconnected: () => void;

  private state: ConnectionState = "connected";
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  constructor(opts: ConnectionMonitorOptions) {
    this.api = opts.api;
    this.mode = opts.mode;
    this.pingInterval = opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL;
    this.maxReconnect = opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT;
    this.onStateChange = opts.onStateChange;
    this.onReconnected = opts.onReconnected;
  }

  start() {
    this.destroyed = false;
    this.setState("connected");
    this.pingTimer = setInterval(() => void this.ping(), this.pingInterval);
  }

  stop() {
    this.destroyed = true;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  /** Call when network status changes (from @capacitor/network). */
  handleNetworkChange(connected: boolean) {
    if (this.destroyed) return;
    if (!connected) {
      this.setState("offline");
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    } else if (this.state === "offline") {
      // Network restored — try to reconnect immediately
      void this.startReconnect();
    }
  }

  /** Call when app returns to foreground. */
  handleForeground() {
    if (this.destroyed) return;
    // Immediate ping, then resume interval
    void this.ping().then((ok) => {
      if (!ok && this.state !== "offline") {
        void this.startReconnect();
      }
    });
    if (!this.pingTimer) {
      this.pingTimer = setInterval(() => void this.ping(), this.pingInterval);
    }
  }

  private setState(next: ConnectionState) {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange(next);
  }

  private async ping(): Promise<boolean> {
    if (this.destroyed || this.state === "offline" || this.state === "reconnecting") return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT);
      // Use listSessions as a lightweight ping — works for both LAN and Relay
      await this.api.listSessions();
      clearTimeout(timeout);
      if ((this.state as ConnectionState) === "reconnecting") {
        this.setState("connected");
        this.reconnectAttempt = 0;
        this.onReconnected();
      }
      return true;
    } catch {
      if (this.state === "connected") {
        void this.startReconnect();
      }
      return false;
    }
  }

  private async startReconnect() {
    if (this.destroyed || this.state === "disconnected") return;
    this.setState("reconnecting");
    this.reconnectAttempt = 0;
    await this.attemptReconnect();
  }

  private async attemptReconnect() {
    if (this.destroyed) return;

    if (this.reconnectAttempt >= this.maxReconnect) {
      this.setState("disconnected");
      return;
    }

    this.reconnectAttempt++;
    const backoff = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 30_000);

    this.reconnectTimer = setTimeout(async () => {
      if (this.destroyed) return;
      const ok = await this.pingDirect();
      if (ok) {
        this.setState("connected");
        this.reconnectAttempt = 0;
        // Restart ping timer
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => void this.ping(), this.pingInterval);
        this.onReconnected();
      } else {
        await this.attemptReconnect();
      }
    }, backoff);
  }

  /** Direct ping without state guards (used during reconnect). */
  private async pingDirect(): Promise<boolean> {
    try {
      await this.api.listSessions();
      return true;
    } catch {
      return false;
    }
  }
}
