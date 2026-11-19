// Diagnostics are observers only; failures cannot alter a flash transaction.
export function observe(listener, event) { try { listener?.(event); } catch { /* Diagnostics cannot interrupt a flash transaction. */ } }
export const hexAddress = n => '0x'+n.toString(16).padStart(6,'0');
