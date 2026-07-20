declare module 'cordova-plugin-adjust/www/adjust' {
  export class AdjustConfig {
    constructor(appToken: string, environment: string);
    setLogLevel(logLevel: string): void;
  }
  export class AdjustEvent {
    constructor(eventToken: string);
    setRevenue(revenue: number, currency: string): void;
  }
  export const AdjustLogLevel: {
    Verbose: string;
    Debug: string;
    Info: string;
    Warn: string;
    Error: string;
    Assert: string;
    Suppress: string;
  };
  export const Adjust: {
    initSdk(config: AdjustConfig): void;
    trackEvent(event: AdjustEvent): void;
  };
}
