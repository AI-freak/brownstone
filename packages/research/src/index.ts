import path from 'node:path';
import type {
  AgentConfig,
  ChatMessage,
  ModelProvider,
  ResearchAnswer,
  ResearchCitation,
  RetrievalMatch,
  ThinkingMode,
  UploadedDocument,
  UserProfile,
} from '@brownstone/contracts';
import { ValidationError } from '@brownstone/errors';
import { generateId, readJsonFile, updateJsonFile } from '@brownstone/storage';
import type { WebSearchProvider } from '@brownstone/web-search';

interface UploadsFile {
  version: 1;
  documents: UploadedDocument[];
}
const EMPTY_UPLOADS: UploadsFile = { version: 1, documents: [] };

function uploadsPath(config: AgentConfig): string {
  return path.join(config.dataDir, 'uploads', 'documents.json');
}

// --- Uploaded documents -----------------------------------------------------

export async function saveUploadedText(
  config: AgentConfig,
  owner: UserProfile,
  filename: string,
  content: string,
  tags: string[],
): Promise<UploadedDocument> {
  if (!filename.trim()) throw new ValidationError('filename is required');
  if (content.length > config.uploadMaxBytes) {
    throw new ValidationError(`Content exceeds ${config.uploadMaxBytes} bytes`);
  }
  const doc: UploadedDocument = {
    id: generateId('doc'),
    ownerUserId: owner.id,
    filename,
    createdAt: new Date().toISOString(),
    byteLength: Buffer.byteLength(content),
    text: content,
    tags,
  };
  await updateJsonFile<UploadsFile>(uploadsPath(config), EMPTY_UPLOADS, (file) => ({
    ...file,
    documents: [...file.documents, doc],
  }));
  return doc;
}

export async function listUploadedDocuments(config: AgentConfig): Promise<UploadedDocument[]> {
  const file = await readJsonFile<UploadsFile>(uploadsPath(config), EMPTY_UPLOADS);
  return file.documents;
}

export async function retrieveUploadedDocuments(
  config: AgentConfig,
  owner: UserProfile,
  query: string,
): Promise<RetrievalMatch[]> {
  const file = await readJsonFile<UploadsFile>(uploadsPath(config), EMPTY_UPLOADS);
  const eligible = file.documents.filter((doc) => doc.ownerUserId === owner.id);
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const scored = eligible.map((doc) => {
    const text = doc.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      // Simple term-frequency: count occurrences, normalize by doc length.
      const matches = countOccurrences(text, term);
      score += matches;
    }
    if (score === 0) return undefined;
    return {
      documentId: doc.id,
      filename: doc.filename,
      score: score / Math.max(1, doc.byteLength / 1000),
      snippet: makeSnippet(doc.text, terms),
    } satisfies RetrievalMatch;
  }).filter((x): x is RetrievalMatch => x !== undefined);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let i = 0;
  while ((i = text.indexOf(term, i)) !== -1) {
    count += 1;
    i += term.length;
  }
  return count;
}

function makeSnippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + 120);
      return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
    }
  }
  return text.slice(0, 180);
}

// --- Research question answering --------------------------------------------

export interface AnswerResearchQuestionArgs {
  config: AgentConfig;
  provider: ModelProvider;
  searchProvider: WebSearchProvider;
  query: string;
  mode: ThinkingMode;
  fetchPages?: boolean;
  sessionId?: string;
}

export async function answerResearchQuestion(args: AnswerResearchQuestionArgs): Promise<ResearchAnswer> {
  const { config, provider, searchProvider, query, mode, fetchPages = true } = args;
  if (!query.trim()) throw new ValidationError('Research query must be non-empty');

  const search = await searchProvider.search(query, config.maxSearchResults);
  const pagesToFetch = fetchPages ? search.results.slice(0, config.maxFetchedPagesPerResearch) : [];
  const fetched: ResearchAnswer['fetchedPages'] = [];

  for (const result of pagesToFetch) {
    try {
      const response = await fetch(result.url, { redirect: 'follow' });
      if (!response.ok) continue;
      const text = await response.text();
      fetched.push({
        url: result.url,
        title: result.title,
        snippet: result.snippet ?? '',
        contentPreview: stripHtml(text).slice(0, 1500),
      });
    } catch { /* skip */ }
  }

  const citations: ResearchCitation[] = search.results.map((r) => ({
    id: generateId('cite'),
    title: r.title,
    url: r.url,
    snippet: r.snippet ?? '',
    source: r.source,
  }));

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        `You are a careful research assistant. Thinking mode: ${mode}.`,
        'Answer the question using the provided search results.',
        'Cite sources inline by their title.',
        'If results are insufficient, say so plainly.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `Question: ${query}`,
        '',
        'Search results:',
        ...search.results.map((r, i) => `${i + 1}. ${r.title} (${r.url})\n   ${r.snippet ?? ''}`),
        '',
        fetched.length ? 'Page excerpts:' : '',
        ...fetched.map((p) => `# ${p.title}\n${p.contentPreview}`),
      ].filter(Boolean).join('\n'),
    },
  ];

  const result = await provider.complete({ messages, tools: [] });
  const answer = result.outputText.trim();
  const summary = answer.split('\n')[0].slice(0, 280);

  return {
    query, mode, answer, summary,
    provider: provider.modelName,
    search,
    citations,
    fetchedPages: fetched,
  };
}

function stripHtml(text: string): string {
  return text.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
