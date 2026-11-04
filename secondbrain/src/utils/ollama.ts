export interface OllamaCheckResult {
  isConnected: boolean;
  models: string[];
  pingMs: number;
  error?: string;
}

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'gpt-oss:20b';

/**
 * Ping local Ollama desktop API to check connectivity and fetch available models
 */
export async function checkOllamaConnection(hostUrl: string = DEFAULT_OLLAMA_HOST): Promise<OllamaCheckResult> {
  const cleanUrl = hostUrl.replace(/\/+$/, '');
  const startTime = performance.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(`${cleanUrl}/api/tags`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const pingMs = Math.round(performance.now() - startTime);

    if (!res.ok) {
      return {
        isConnected: false,
        models: [],
        pingMs,
        error: `Ollama returned status ${res.status}: ${res.statusText}`,
      };
    }

    const data = await res.json();
    const models: string[] = Array.isArray(data?.models)
      ? data.models.map((m: { name?: string; model?: string }) => m.name || m.model || '').filter(Boolean)
      : [];

    return {
      isConnected: true,
      models,
      pingMs,
    };
  } catch (err: unknown) {
    const pingMs = Math.round(performance.now() - startTime);
    const errorMessage = err instanceof Error ? err.message : 'Unknown connection error';

    // Check for probable CORS restriction or offline Ollama
    let friendlyError = `Could not connect to Ollama at ${cleanUrl}.`;
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError') || errorMessage.includes('abort')) {
      friendlyError = `Connection refused or CORS blocked. Make sure Ollama is running and OLLAMA_ORIGINS="*" is allowed.`;
    }

    return {
      isConnected: false,
      models: [],
      pingMs,
      error: friendlyError,
    };
  }
}
