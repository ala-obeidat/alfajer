// In-app toast system. Replaces native alert() throughout the app so
// notifications match the dark theme and don't break flow.

type ToastVariant = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  text: string;
  variant: ToastVariant;
  ttl: number;
}

let nextId = 1;

class ToastStore {
  list = $state<Toast[]>([]);

  push(text: string, variant: ToastVariant = 'info', ttl = 4000) {
    const t: Toast = { id: nextId++, text, variant, ttl };
    this.list.push(t);
    if (ttl > 0) {
      setTimeout(() => this.dismiss(t.id), ttl);
    }
    return t.id;
  }

  dismiss(id: number) {
    const i = this.list.findIndex(t => t.id === id);
    if (i >= 0) this.list.splice(i, 1);
  }

  info(text: string, ttl?: number) { return this.push(text, 'info', ttl); }
  success(text: string, ttl?: number) { return this.push(text, 'success', ttl); }
  warn(text: string, ttl?: number) { return this.push(text, 'warn', ttl); }
  error(text: string, ttl?: number) { return this.push(text, 'error', ttl ?? 6000); }
}

export const toast = new ToastStore();
