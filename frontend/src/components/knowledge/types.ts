export type KnowledgeStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'NOT_STARTED' | 'PARTIAL' | 'SKIPPED';

export interface ScenarioRef {
  scenarioId: string;
  name: string;
  published: boolean;
  draft: boolean;
  version: number | null;
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  mimeType: string;
  status: KnowledgeStatus;
  ready: boolean;
  error: string | null;
  pageCount: number | null;
  chunkCount: number;
  charCount: number;
  fileName: string | null;
  sizeBytes: number | null;
  hasSource: boolean;
  createdAt: string;
  updatedAt: string;
  referencedBy: ScenarioRef[];
}

export interface KnowledgeChunk {
  id: string;
  ordinal: number;
  page: number | null;
  heading: string | null;
  text: string;
  tokenCount: number;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  page: number | null;
  heading: string | null;
  text: string;
  snippet: string;
  score: number;
  citation: string;
}

export const KNOWLEDGE_ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,application/pdf,text/plain,text/markdown,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function isProcessing(s: KnowledgeStatus) {
  return s === 'QUEUED' || s === 'PROCESSING';
}

export function formatBytes(n?: number | null) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function typeLabel(mime: string) {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('wordprocessingml')) return 'Word';
  if (mime === 'text/markdown') return 'Markdown';
  if (mime === 'text/csv') return 'CSV';
  return 'Text';
}
