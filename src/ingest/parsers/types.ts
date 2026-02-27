import type { ParsedMessage, StructuredMessage } from "../types";

export type ParsedSession = {
  session: {
    id: string;
    title: string;
    created_at: string;
  };
  messages: Array<ParsedMessage | StructuredMessage>;
  metadata: {
    total_tokens?: number;
    total_duration_ms?: number;
  };
};
