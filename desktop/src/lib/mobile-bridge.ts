/**
 * Capacitor plugin bridge layer.
 * All imports are dynamic so the desktop (Tauri) build never bundles native plugins.
 * Every public function is guarded by isMobileApp().
 */

import { isMobileApp } from "./api-factory";

// ─── Preferences (Phase 1) ─────────────────────────────────────────────────

export async function getPreference(key: string): Promise<string | null> {
  if (!isMobileApp()) return null;
  const { Preferences } = await import("@capacitor/preferences");
  const { value } = await Preferences.get({ key });
  return value;
}

export async function setPreference(key: string, value: string): Promise<void> {
  if (!isMobileApp()) return;
  const { Preferences } = await import("@capacitor/preferences");
  await Preferences.set({ key, value });
}

export async function removePreference(key: string): Promise<void> {
  if (!isMobileApp()) return;
  const { Preferences } = await import("@capacitor/preferences");
  await Preferences.remove({ key });
}

// ─── Network (Phase 2) ──────────────────────────────────────────────────────

export type NetworkListener = (connected: boolean) => void;

export async function addNetworkListener(cb: NetworkListener): Promise<() => void> {
  if (!isMobileApp()) return () => {};
  const { Network } = await import("@capacitor/network");
  const handle = await Network.addListener("networkStatusChange", (status) => {
    cb(status.connected);
  });
  return () => { void handle.remove(); };
}

export async function isNetworkConnected(): Promise<boolean> {
  if (!isMobileApp()) return true;
  const { Network } = await import("@capacitor/network");
  const status = await Network.getStatus();
  return status.connected;
}

// ─── App Lifecycle (Phase 3) ────────────────────────────────────────────────

export type AppStateListener = (isActive: boolean) => void;

export async function addAppStateListener(cb: AppStateListener): Promise<() => void> {
  if (!isMobileApp()) return () => {};
  const { App } = await import("@capacitor/app");
  const handle = await App.addListener("appStateChange", ({ isActive }) => {
    cb(isActive);
  });
  return () => { void handle.remove(); };
}

// ─── QR / Barcode Scanning (Phase 5) ────────────────────────────────────────

export async function scanQrCode(): Promise<string | null> {
  if (!isMobileApp()) return null;
  const { BarcodeScanner } = await import("@capacitor-mlkit/barcode-scanning");

  // Request camera permission
  const { camera } = await BarcodeScanner.requestPermissions();
  if (camera !== "granted" && camera !== "limited") {
    throw new Error("Camera permission denied");
  }

  const { barcodes } = await BarcodeScanner.scan();
  return barcodes.length > 0 ? barcodes[0].rawValue : null;
}

// ─── Haptics (Phase 6) ──────────────────────────────────────────────────────

export async function hapticSuccess(): Promise<void> {
  if (!isMobileApp()) return;
  const { Haptics, NotificationType } = await import("@capacitor/haptics");
  await Haptics.notification({ type: NotificationType.Success });
}

export async function hapticError(): Promise<void> {
  if (!isMobileApp()) return;
  const { Haptics, NotificationType } = await import("@capacitor/haptics");
  await Haptics.notification({ type: NotificationType.Error });
}

export async function hapticLight(): Promise<void> {
  if (!isMobileApp()) return;
  const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
  await Haptics.impact({ style: ImpactStyle.Light });
}

export async function hapticMedium(): Promise<void> {
  if (!isMobileApp()) return;
  const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
  await Haptics.impact({ style: ImpactStyle.Medium });
}

// ─── Keyboard (Phase 6) ─────────────────────────────────────────────────────

export async function initKeyboard(): Promise<void> {
  if (!isMobileApp()) return;
  const { Keyboard, KeyboardResize } = await import("@capacitor/keyboard");
  await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
  await Keyboard.setScroll({ isDisabled: true });
}

// ─── Status Bar (Phase 6) ───────────────────────────────────────────────────

export async function initStatusBar(isDark: boolean): Promise<void> {
  if (!isMobileApp()) return;
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light });
  await StatusBar.setBackgroundColor({ color: isDark ? "#141a16" : "#f5f7f6" });
}

// ─── Splash Screen (Phase 6) ────────────────────────────────────────────────

export async function hideSplash(): Promise<void> {
  if (!isMobileApp()) return;
  const { SplashScreen } = await import("@capacitor/splash-screen");
  await SplashScreen.hide();
}
