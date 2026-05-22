import type { ThinkingMode } from './config.js';
import type { OwnedResource } from './auth.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  provider: string;
}

export interface ResearchCitation {
  id: string;
  title: string;
  url: string;
  snippet: string;
  quote?: string;
  source?: string;
}

export interface ResearchAnswer {
  query: string;
  mode: ThinkingMode;
  answer: string;
  summary: string;
  provider: string;
  search: SearchResponse;
  citations: ResearchCitation[];
  fetchedPages: Array<{ url: string; title: string; snippet: string; contentPreview: string }>;
}

export interface UploadedDocument extends OwnedResource {
  id: string;
  filename: string;
  createdAt: string;
  byteLength: number;
  text: string;
  tags: string[];
}

export interface RetrievalMatch {
  documentId: string;
  filename: string;
  score: number;
  snippet: string;
}
