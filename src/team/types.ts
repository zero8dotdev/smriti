/**
 * team/types.ts - Types for 3-stage segmentation pipeline
 *
 * Defines interfaces for knowledge units, segmentation results,
 * and document generation across the pipeline.
 */

/**
 * A knowledge unit: a distinct, self-contained piece of knowledge
 * extracted from a session. Can be documented independently.
 */
export interface KnowledgeUnit {
  id: string;
  topic: string;
  category: string;
  relevance: number; // 0-10 score
  entities: string[]; // libraries, patterns, file paths
  files: string[]; // modified files
  plainText: string; // extracted content from messages
  lineRanges: Array<{ start: number; end: number }>; // message indices
  suggestedTitle?: string;
}

/**
 * Result of Stage 1: Session segmentation
 */
export interface SegmentationResult {
  sessionId: string;
  units: KnowledgeUnit[];
  rawSessionText: string;
  totalMessages: number;
  processingDurationMs: number;
}

/**
 * Result of Stage 2: Document generation for a knowledge unit
 */
export interface DocumentGenerationResult {
  unitId: string;
  category: string;
  title: string;
  markdown: string;
  frontmatter: Record<string, string | string[]>;
  filename: string;
  tokenEstimate: number;
}

/**
 * Options for segmentation
 */
export interface SegmentationOptions {
  model?: string;
  minRelevance?: number;
  projectSmritiDir?: string;
}

/**
 * Options for document generation
 */
export interface DocumentationOptions {
  model?: string;
  projectSmritiDir?: string;
  author?: string;
}
