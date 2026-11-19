/** Eventos enviados ao navegador via SSE. Tipos compartilhados com o agenda-web. */
export type EventoChat =
  | { tipo: "inicio"; conversaId: string }
  | { tipo: "tool_call"; callId: string; nome: string; args: Record<string, unknown> }
  | {
      tipo: "tool_result";
      callId: string;
      nome: string;
      isError: boolean;
      texto: string;
      dados?: Record<string, unknown>;
      /** true quando a tool alterou a agenda (o calendário deve recarregar). */
      mutou: boolean;
      cancelada?: boolean;
    }
  | {
      tipo: "confirmacao";
      callId: string;
      nome: string;
      args: Record<string, unknown>;
      /** Texto legível do que será feito, ex: "Remover “Daily do time” (20/11 09:30–09:45)". */
      resumo: string;
    }
  | { tipo: "mensagem"; texto: string }
  | { tipo: "erro"; mensagem: string }
  | { tipo: "fim" };

/** Contexto de data/hora do navegador, para o modelo resolver "amanhã", "sexta" etc. */
export interface ContextoUsuario {
  /** Agora, em ISO 8601 com offset, ex: 2026-11-19T10:30:00-03:00 */
  agora: string;
  /** Fuso IANA, ex: America/Sao_Paulo */
  fuso: string;
}
