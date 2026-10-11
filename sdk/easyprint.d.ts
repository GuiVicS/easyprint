// Tipos do SDK EasyPrint v1.0.0

export type EasyPrintStatus =
  | 'connecting'
  | 'ready'
  | 'not_running'
  | 'browser_blocked'
  | 'awaiting_approval'
  | 'denied'
  | 'unsupported_browser'
  | 'disconnected';

export type EasyPrintErrorCode =
  | 'NOT_RUNNING' | 'BROWSER_BLOCKED' | 'NOT_AUTHORIZED' | 'DENIED' | 'UNSUPPORTED_BROWSER'
  | 'PRINTER_NOT_FOUND' | 'NO_DEFAULT_PRINTER' | 'PRINT_FAILED' | 'INVALID_DOCUMENT'
  | 'INVALID_TOKEN' | 'ORIGIN_REQUIRED' | 'TIMEOUT' | 'DISCONNECTED' | 'INTERNAL'
  | 'TOO_LARGE' | 'UNSUPPORTED' | 'INVALID_ROUTE' | 'POLICY_BLOCKED';

export interface EasyPrintError extends Error {
  name: 'EasyPrintError';
  code: EasyPrintErrorCode;
  /** Como resolver, em linguagem simples (pt-BR). Mostre ao usuário. */
  hint: string | null;
}

export interface ConnectOptions {
  /** Nome do seu sistema — aparece na janela de permissão do EasyPrint. */
  appName?: string;
  /** Padrão: '127.0.0.1' */
  host?: string;
  /** Padrão: [17777, 17778, 17779] */
  ports?: number[];
  /** Token de "App local" (apenas para apps sem navegador / file://). */
  token?: string;
  /** Reconecta sozinho se o EasyPrint fechar/abrir. Padrão: true */
  autoReconnect?: boolean;
  /**
   * Finalidades que o seu sistema usa, com o nome que o lojista vai ver no painel.
   * O lojista escolhe a impressora de cada uma (ex.: etiqueta → Zebra, danfe → Laser).
   * Ex.: { pedido: 'Pedidos (cozinha)', etiqueta: 'Etiquetas de envio', danfe: 'Notas fiscais (DANFE)' }
   */
  routes?: Record<string, string>;
  /** Link de download do EasyPrint mostrado quando ele não está instalado. */
  downloadUrl?: string;
  /** Timeout de cada operação em ms. Padrão: 60000 */
  requestTimeout?: number;
  /** Cria um cliente novo em vez de reutilizar o compartilhado. */
  fresh?: boolean;
  debug?: boolean;
}

export interface Diagnosis {
  ok: boolean;
  status: EasyPrintStatus;
  title: string;
  message: string;
  /** Passos para o usuário resolver. */
  steps: string[];
  downloadUrl?: string | null;
}

export interface PrinterInfo {
  name: string;
  kind: 'thermal' | 'label' | 'office' | 'system' | 'virtual';
  online: boolean;
  isDefault: boolean;
  mode: 'escpos' | 'zpl' | 'office' | 'virtual';
  paperWidth?: 58 | 80;
  labelWidth?: number;
  labelHeight?: number | null;
  dpi?: 203 | 300;
  paperSize?: string;
  /** Caracteres por linha. */
  columns: number;
}

export interface PrintOptions {
  /** Nome (ou parte do nome) da impressora. Tem prioridade sobre `route`. */
  printer?: string;
  /** Finalidade (ex.: 'etiqueta', 'danfe', 'cozinha'). O lojista escolhe a impressora no painel; sem configuração usa a padrão. */
  route?: string;
  copies?: number;
  /** Nome do trabalho na fila do sistema. */
  jobName?: string;
  /** Sobrescreve o perfil da impressora só nesta impressão. */
  options?: Partial<{ paperWidth: 58 | 80; codepage: 'cp860' | 'cp850' | 'cp1252' | 'ascii'; columns: number; autoCut: boolean; labelWidth: number; labelHeight: number; dpi: 203 | 300; paperSize: string }>;
}

export interface PrintResult {
  jobId: string;
  printer: string;
  mode: string;
  status: 'done';
  /** Como a impressora foi escolhida. 'default-fallback' = a finalidade ainda não foi configurada pelo lojista. */
  routedBy: 'printer' | 'route' | 'default' | 'default-fallback';
  /** Páginas impressas (PDF). */
  pages?: number;
}

export interface PdfOptions extends PrintOptions {
  /** Páginas, ex.: '1', '1-3,5'. Padrão: todas. */
  pages?: string;
  /** 'page' (padrão) ajusta à folha; 'actual' mantém o tamanho real. */
  fit?: 'page' | 'actual';
  /** Papel em impressoras comuns: 'A4', 'A5', 'Letter'… Padrão: o do perfil ('auto'). */
  paperSize?: string;
  /** Resolução de renderização em impressoras comuns (72–600). Padrão 200. */
  dpi?: number;
}

export interface RouteInfo { route: string; label: string; printer: string | null; }

export type Align = 'left' | 'center' | 'right';

export type Block =
  | string
  | { type: 'text'; value: string; align?: Align; bold?: boolean; size?: 1 | 2 | 3; underline?: boolean; invert?: boolean }
  | { type: 'title'; value: string }
  | { type: 'line'; char?: string }
  | { type: 'row'; left: string; right: string; bold?: boolean; size?: 1 | 2 | 3 }
  | { type: 'item'; qty?: number | string; name: string; price?: string; note?: string; bold?: boolean }
  | { type: 'total'; label?: string; value: string }
  | { type: 'qr'; value: string; size?: number; align?: Align }
  | { type: 'barcode'; value: string; format?: 'CODE128' | 'EAN13'; align?: Align }
  | { type: 'image'; src: string; align?: Align; width?: number }
  | { type: 'feed'; lines?: number }
  | { type: 'cut' }
  | { type: 'drawer' };

export interface PrintDocument { blocks: Block[]; }

export interface ReceiptBuilder {
  text(value: string, opts?: { align?: Align; bold?: boolean; size?: 1 | 2 | 3; underline?: boolean; invert?: boolean }): this;
  center(value: string, opts?: { bold?: boolean; size?: 1 | 2 | 3 }): this;
  bold(value: string, opts?: { align?: Align; size?: 1 | 2 | 3 }): this;
  title(value: string): this;
  line(char?: string): this;
  row(left: string, right: string, opts?: { bold?: boolean; size?: 1 | 2 | 3 }): this;
  item(qty: number | string | null, name: string, price?: string, note?: string): this;
  total(label: string, value: string): this;
  qr(value: string, size?: number): this;
  barcode(value: string, format?: 'CODE128' | 'EAN13'): this;
  /** src = PNG em data URL. Use `await EasyPrint.image(url)`. */
  image(src: string, opts?: { align?: Align; width?: number }): this;
  feed(lines?: number): this;
  cut(): this;
  drawer(): this;
  build(): PrintDocument;
}

export type RawData = string | Uint8Array | ArrayBuffer | Array<string | number | Uint8Array> | { hex: string } | { base64: string } | { text: string };

export interface EasyPrintClient {
  readonly status: EasyPrintStatus;
  readonly port: number | null;
  readonly agent: { name: string; version: string } | null;
  /** Escuta mudanças de status. Chama imediatamente com o status atual. Retorna função para cancelar. */
  on(event: 'status', fn: (status: EasyPrintStatus, diagnosis: Diagnosis) => void): () => void;
  on(event: 'ready', fn: () => void): () => void;
  /** Resolve quando pronto; rejeita com EasyPrintError explicativo. */
  ready(timeoutMs?: number): Promise<EasyPrintClient>;
  printers(): Promise<PrinterInfo[]>;
  defaultPrinter(): Promise<PrinterInfo | null>;
  print(what: ReceiptBuilder | PrintDocument | Block[] | string | { raw: RawData } | { text: string } | { image: string } | { pdf: string; pdfOptions?: Omit<PdfOptions, keyof PrintOptions> }, opts?: PrintOptions): Promise<PrintResult>;
  printRaw(data: RawData, opts?: PrintOptions): Promise<PrintResult>;
  /** Imprime PDF: URL (baixada com os cookies do site), data URL, Blob, ArrayBuffer ou Uint8Array. Até 25 MB. */
  printPdf(source: string | Blob | ArrayBuffer | Uint8Array, opts?: PdfOptions): Promise<PrintResult>;
  /**
   * Imprime HTML (string ou elemento da página, com os estilos da página). Renderizado num navegador
   * isolado; JavaScript desligado por padrão. Funciona em impressora comum, térmica e etiqueta.
   */
  printHtml(html: string | Element, opts?: PrintOptions & { paperSize?: string; javascript?: boolean; baseUrl?: string }): Promise<PrintResult>;
  /** Finalidades e as impressoras escolhidas pelo lojista. */
  routes(): Promise<RouteInfo[]>;
  printText(text: string, opts?: PrintOptions): Promise<PrintResult>;
  printImage(src: string | HTMLImageElement | HTMLCanvasElement, opts?: PrintOptions & { maxWidth?: number }): Promise<PrintResult>;
  /** Explica o status atual com passos de correção (pt-BR). */
  diagnose(): Diagnosis;
  disconnect(): void;
}

export interface EasyPrintStatic {
  VERSION: string;
  connect(options?: ConnectOptions): EasyPrintClient;
  receipt(): ReceiptBuilder;
  image(src: string | HTMLImageElement | HTMLCanvasElement, maxWidth?: number): Promise<string>;
  widget(client: EasyPrintClient, container: string | Element, opts?: { align?: 'left' | 'right'; readyLabel?: string }): () => void;
  messages: Record<EasyPrintStatus, { title: string; message: string; steps: string[] }>;
}

declare const EasyPrint: EasyPrintStatic;
export default EasyPrint;
export declare const connect: EasyPrintStatic['connect'];
export declare const receipt: EasyPrintStatic['receipt'];
export declare const image: EasyPrintStatic['image'];
export declare const widget: EasyPrintStatic['widget'];
export declare const messages: EasyPrintStatic['messages'];
export declare const VERSION: string;

declare global {
  interface Window { EasyPrint: EasyPrintStatic; }
}
