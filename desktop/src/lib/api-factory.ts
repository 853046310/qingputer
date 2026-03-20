import type { IRuntimeApi } from "./api-interface";
import { RemoteRuntimeApi, type RemoteConfig } from "./api-remote";
import { RelayRuntimeApi, type RelayConfig } from "./api-relay";

/** True when running inside a Tauri desktop shell (IPC bridge available). */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

/** True on iOS / Android builds where no local Runtime is spawned. */
export function isMobileApp(): boolean {
  return !isDesktopApp();
}

export function createRemoteApi(config: RemoteConfig): IRuntimeApi {
  return new RemoteRuntimeApi(config);
}

export function createRelayApi(config: RelayConfig): IRuntimeApi {
  return new RelayRuntimeApi(config);
}
