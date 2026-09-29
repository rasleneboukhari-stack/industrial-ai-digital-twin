import type { FactoryBackend } from './FactoryBackend';
import { MockFactoryBackend } from './MockFactoryBackend';
import { WebSocketFactoryBackend } from './WebSocketFactoryBackend';

export function createFactoryBackend(): FactoryBackend {
  const useRealBackend =
      import.meta.env.VITE_USE_REAL_BACKEND === 'true';

  if (!useRealBackend) {
    return new MockFactoryBackend();
  }

  const wsUrl =
      import.meta.env.VITE_FACTORY_WS_URL ??
      'ws://localhost:8080/ws/factory';

  const httpBaseUrl =
      import.meta.env.VITE_FACTORY_HTTP_URL ??
      'http://localhost:8080/api';

  return new WebSocketFactoryBackend(
      wsUrl,
      httpBaseUrl
  );
}