import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.qingputer.mobile',
  appName: 'Qingputer',
  webDir: '../desktop/dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: false,
      backgroundColor: "#0d1410",
    },
    Keyboard: {
      resize: "native",
      resizeOnFullScreen: true,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#141a16",
    },
  },
  ios: {
    contentInset: "automatic",
    allowsLinkPreview: false,
  },
};

export default config;
