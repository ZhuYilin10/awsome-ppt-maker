export type AiProviderId = 'openai';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ConnectionTestStatus = 'success' | 'auth-error' | 'model-error' | 'network-error' | 'error';

export type ConnectionTestResult = {
  status: ConnectionTestStatus;
  testedAt: string;
  message?: string;
};

export type AiSettingsSnapshot = {
  provider: AiProviderId;
  baseUrl: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  configured: boolean;
  runtimeReady: boolean;
  lastTest?: ConnectionTestResult;
};

export type AiSettingsInput = {
  provider: AiProviderId;
  apiKey?: string;
  baseUrl: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
};

export type AiRuntimeStatus = {
  configured: boolean;
  runtimeReady: boolean;
  provider: AiProviderId;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  error?: string;
};
