export interface BrowserNavigateRequest {
  url: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export interface BrowserSubmitRequest {
  url: string;
  method?: 'POST';
  fields: Record<string, string>;
}

export interface BrowserCaptureResult {
  ok: boolean;
  title?: string;
  url?: string;
  textPreview?: string;
  screenshotPath?: string;
}

export interface BrowserSubmitResult {
  ok: boolean;
  url?: string;
  status?: number;
  responsePreview?: string;
  artifactPath?: string;
}
