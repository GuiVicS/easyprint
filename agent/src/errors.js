'use strict';
// Todo erro tem: código estável (para o código do app), mensagem humana e dica de como resolver.
class EPError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint || null;
  }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint }; }
}

function toErrorPayload(e) {
  if (e instanceof EPError) return e.toJSON();
  return { code: e.code || 'INTERNAL', message: e.message || 'Erro inesperado.', hint: e.hint || null };
}

module.exports = { EPError, toErrorPayload };
