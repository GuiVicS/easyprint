// Tipos do núcleo embutido do EasyPrint (require('easyprint/core')).
export interface CorePrinter { name: string; kind: 'thermal' | 'label' | 'office' | 'system' | 'virtual'; online: boolean; isDefault: boolean }
export interface ManagedConnection {
  id: string; name?: string;
  /** Endereço da fila (https; http só em localhost). O núcleo acrescenta /v1/agent/... */
  url: string;
  deviceId: string;
  /** Ed25519 (SPKI base64) que assina os trabalhos. */
  publicKey: string;
  /** X25519 privada deste computador (PKCS8 base64), de generateEncryptionKeys(). */
  privateKey: string;
  /** Devolve o token atual a cada chamada (pode ter sido renovado). */
  getToken: () => string | Promise<string>;
  agent?: { name?: string; version?: string };
  allowRaw?: boolean; allowDrawer?: boolean; allowPdf?: boolean;
}
export interface ConnectionState {
  id: string; name: string; host: string; deviceId: string; fingerprint: string; managed: boolean;
  state: 'connecting' | 'online' | 'offline' | 'unauthorized' | 'paused';
  lastContact: string | null; lastError: string | null; printed: number; rejected: number;
}
export interface CloudRelay {
  attach(c: ManagedConnection): ConnectionState;
  detach(id: string): boolean;
  reportStatus(id: string): Promise<number>;
  publicState(): ConnectionState[];
  on(event: 'state', fn: (e: { id: string; state: ConnectionState['state']; error: string | null }) => void): this;
  on(event: 'security', fn: (e: { connection: string; code: string; message: string }) => void): this;
}
export interface PrintCore {
  version: string;
  cloud: CloudRelay;
  start(): Promise<void>;
  stop(): void;
  printers(): Promise<CorePrinter[]>;
  setRoutes(routes: Record<string, string>): void;
  setDefaultPrinter(name: string | null): void;
}
export function createCore(o: { home: string; log?: (...a: unknown[]) => void }): PrintCore;
export function generateEncryptionKeys(): { encryptionKey: string; privateKey: string };
export const VERSION: string;
