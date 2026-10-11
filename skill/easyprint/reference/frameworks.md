# Modelos por framework

Todos os modelos assumem o SDK copiado em `src/lib/easyprint/easyprint.js` (com o `.d.ts` ao lado). Ajuste os caminhos e os nomes dos campos do pedido ao projeto.

---

## HTML puro (sem bundler)

```html
<script src="/vendor/easyprint.js"></script>
<span id="easyprint-status"></span>
<button id="btn-print">Imprimir pedido</button>
<script>
  const printer = EasyPrint.connect({ appName: 'Minha Loja', downloadUrl: 'https://minhaloja.com/easyprint' });
  EasyPrint.widget(printer, '#easyprint-status');

  document.getElementById('btn-print').addEventListener('click', async () => {
    try {
      await printer.print(
        EasyPrint.receipt().title('PEDIDO #123').line()
          .item(2, 'X-Burguer', 'R$ 59,80', 'sem cebola')
          .total('TOTAL', 'R$ 59,80').cut()
      );
      alert('Enviado para a impressora!');
    } catch (err) {
      alert(err.message + (err.hint ? '\n\n' + err.hint : ''));
    }
  });
</script>
```

---

## React (Vite / CRA)

`src/lib/printing.ts`
```ts
import EasyPrint from './easyprint/easyprint.js';
export { EasyPrint };
export const printer = EasyPrint.connect({ appName: 'Minha Loja' });
```

`src/hooks/useEasyPrint.ts`
```ts
import { useEffect, useState } from 'react';
import { printer } from '../lib/printing';
import type { Diagnosis } from '../lib/easyprint/easyprint';

export function useEasyPrint() {
  const [diagnosis, setDiagnosis] = useState<Diagnosis>(printer.diagnose());
  useEffect(() => printer.on('status', (_s, d) => setDiagnosis(d)), []);
  return { printer, diagnosis, ready: diagnosis.ok };
}
```

`src/components/PrinterStatus.tsx`
```tsx
import { useState } from 'react';
import { useEasyPrint } from '../hooks/useEasyPrint';

export function PrinterStatus() {
  const { diagnosis } = useEasyPrint();
  const [open, setOpen] = useState(false);
  return (
    <div className="printer-status">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ color: diagnosis.ok ? 'green' : 'orange' }}>●</span> {diagnosis.ok ? 'Impressora pronta' : diagnosis.title}
      </button>
      {open && !diagnosis.ok && (
        <div role="dialog">
          <p>{diagnosis.message}</p>
          <ol>{diagnosis.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </div>
      )}
    </div>
  );
}
```

Botão de imprimir:
```tsx
const [busy, setBusy] = useState(false);
async function handlePrint() {
  setBusy(true);
  try { await printer.print(orderToReceipt(order), { jobName: `Pedido ${order.number}` }); toast.success('Impresso!'); }
  catch (err: any) { toast.error(`${err.message}${err.hint ? ' — ' + err.hint : ''}`); }
  finally { setBusy(false); }
}
```

---

## Next.js (App Router)

O SDK só existe no navegador. Conecte apenas em componentes `'use client'` e **nunca** no topo de um módulo importado por Server Components.

`src/lib/printing.ts`
```ts
'use client';
import type { EasyPrintClient } from './easyprint/easyprint';

let client: EasyPrintClient | null = null;
export async function getPrinter() {
  if (typeof window === 'undefined') throw new Error('EasyPrint só funciona no navegador');
  if (!client) {
    const { default: EasyPrint } = await import('./easyprint/easyprint.js');
    client = EasyPrint.connect({ appName: 'Minha Loja' });
  }
  return client;
}
```

Hook:
```tsx
'use client';
import { useEffect, useState } from 'react';
import { getPrinter } from '@/lib/printing';

export function useEasyPrint() {
  const [diagnosis, setDiagnosis] = useState<any>({ ok: false, status: 'connecting', title: 'Conectando…', message: '', steps: [] });
  useEffect(() => {
    let off = () => {};
    getPrinter().then((p) => { off = p.on('status', (_s, d) => setDiagnosis(d)); });
    return () => off();
  }, []);
  return diagnosis;
}
```

Para imprimir: `const p = await getPrinter(); await p.print(...)`. O builder fica em `(await import('./easyprint/easyprint.js')).default.receipt()`, ou monte o documento como objeto `{ blocks: [...] }`, que não precisa importar nada.

---

## Vue 3 / Nuxt 3

`src/composables/useEasyPrint.ts`
```ts
import { ref, onMounted, onBeforeUnmount } from 'vue';
import EasyPrint from '@/lib/easyprint/easyprint.js';

let printer: ReturnType<typeof EasyPrint.connect> | null = null;

export function useEasyPrint() {
  const diagnosis = ref({ ok: false, title: 'Conectando…', message: '', steps: [] as string[], status: 'connecting' });
  let off = () => {};
  onMounted(() => {
    printer ??= EasyPrint.connect({ appName: 'Minha Loja' });
    off = printer.on('status', (_s, d) => (diagnosis.value = d));
  });
  onBeforeUnmount(() => off());
  const print = (doc: any, opts?: any) => printer!.print(doc, opts);
  return { diagnosis, print, EasyPrint };
}
```

No Nuxt, use o composable apenas em componentes client-side (`<ClientOnly>`) ou num plugin `plugins/easyprint.client.ts`.

---

## Angular

`src/app/printing.service.ts`
```ts
import { Injectable, NgZone, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import EasyPrint from '../lib/easyprint/easyprint.js';

@Injectable({ providedIn: 'root' })
export class PrintingService {
  private zone = inject(NgZone);
  private client = isPlatformBrowser(inject(PLATFORM_ID)) ? EasyPrint.connect({ appName: 'Minha Loja' }) : null;
  diagnosis = signal(this.client?.diagnose() ?? null);

  constructor() {
    this.client?.on('status', (_s, d) => this.zone.run(() => this.diagnosis.set(d)));
  }

  receipt() { return EasyPrint.receipt(); }
  print(doc: any, opts?: any) {
    if (!this.client) return Promise.reject(new Error('Impressão indisponível no servidor'));
    return this.client.print(doc, opts);
  }
}
```

Se o TypeScript reclamar do `.js`, adicione `"allowJs": true` ou declare o módulo usando o `easyprint.d.ts`.

---

## Svelte / SvelteKit

`src/lib/printing.ts`
```ts
import { readable } from 'svelte/store';
import { browser } from '$app/environment';
import EasyPrint from './easyprint/easyprint.js';

export const printer = browser ? EasyPrint.connect({ appName: 'Minha Loja' }) : null;
export const printerStatus = readable(printer?.diagnose() ?? null, (set) => (printer ? printer.on('status', (_s, d) => set(d)) : undefined));
export { EasyPrint };
```

---

## Back-end local / Electron / scripts (sem navegador)

Crie um token no painel do EasyPrint (**Sites e apps → Apps locais**) e passe em `connect`:

```js
const EasyPrint = require('./easyprint.js'); // Node 22+ tem WebSocket global
const printer = EasyPrint.connect({ token: process.env.EASYPRINT_TOKEN, appName: 'Servidor da loja' });
await printer.print({ blocks: ['Olá do servidor!', { type: 'cut' }] });
```

---

## Testes (mock do cliente)

```ts
const fakePrinter = {
  status: 'ready',
  print: vi.fn().mockResolvedValue({ jobId: 'x', printer: 'Simulador', mode: 'virtual', status: 'done' }),
  on: (_e: string, fn: Function) => { fn('ready', { ok: true, status: 'ready', title: '', message: '', steps: [] }); return () => {}; },
  diagnose: () => ({ ok: true, status: 'ready', title: '', message: '', steps: [] }),
};
vi.mock('@/lib/printing', () => ({ printer: fakePrinter }));
```

Teste também a conversão `orderToReceipt(order).build()`. O resultado é um objeto JSON simples, fácil de comparar com um snapshot.
