/**
 * Location: src/agents/ingestManager/tools/services/PptxExtractionService.ts
 * Purpose: Extract text and speaker notes from PPTX files using lightweight OOXML parsing.
 *
 * Used by: IngestionPipelineService
 * Dependencies: jszip, fast-xml-parser
 */

import type JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { PptxExtractionResult, PptxSlideContent } from '../../types';

const PRESENTATION_PATH = 'ppt/presentation.xml';
const PRESENTATION_RELS_PATH = 'ppt/_rels/presentation.xml.rels';
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const NOTES_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
});

interface RelationshipEntry {
  Id?: string;
  Target?: string;
  Type?: string;
}

/**
 * Convert a PPTX file into slide text plus speaker notes.
 */
export async function extractPptxContent(pptxData: ArrayBuffer): Promise<PptxExtractionResult> {
  const JSZipModule = await import('jszip');
  const zip = await JSZipModule.default.loadAsync(pptxData);
  const warnings: string[] = [];
  const slidePaths = await getSlidePaths(zip, warnings);
  const slides: PptxSlideContent[] = [];

  for (let index = 0; index < slidePaths.length; index += 1) {
    const slidePath = slidePaths[index];
    const slideXml = await readZipText(zip, slidePath);
    if (!slideXml) {
      warnings.push(`Skipped missing slide part: ${slidePath}`);
      continue;
    }

    const slideParagraphs = extractParagraphs(slideXml);
    const notesPath = await getNotesSlidePath(zip, slidePath);
    const notesXml = notesPath ? await readZipText(zip, notesPath) : null;
    const notesParagraphs = notesXml ? extractParagraphs(notesXml) : [];

    slides.push({
      slideNumber: index + 1,
      text: slideParagraphs.join('\n\n').trim(),
      notes: notesParagraphs.length > 0 ? notesParagraphs.join('\n\n').trim() : undefined
    });
  }

  if (slides.length === 0) {
    throw new Error('No slides with extractable text were found in this PowerPoint.');
  }

  return { slides, warnings };
}

async function getSlidePaths(zip: JSZip, warnings: string[]): Promise<string[]> {
  const [presentationXml, relationshipsXml] = await Promise.all([
    readZipText(zip, PRESENTATION_PATH),
    readZipText(zip, PRESENTATION_RELS_PATH)
  ]);

  if (!presentationXml || !relationshipsXml) {
    warnings.push('Presentation metadata was incomplete. Falling back to slide filename order.');
    return getFallbackSlidePaths(zip);
  }

  const relationships = xmlParser.parse(relationshipsXml) as {
    Relationships?: { Relationship?: RelationshipEntry[] | RelationshipEntry };
  };

  const relationshipMap = new Map<string, string>();
  for (const rel of arrayify(relationships.Relationships?.Relationship)) {
    if (rel.Id && rel.Target && rel.Type === SLIDE_REL_TYPE) {
      relationshipMap.set(rel.Id, normalizeZipPath('ppt', rel.Target));
    }
  }

  const orderedPaths = extractSlideRelationshipIds(presentationXml)
    .map((relationshipId) => relationshipMap.get(relationshipId))
    .filter((path): path is string => Boolean(path));

  if (orderedPaths.length === 0) {
    warnings.push('No ordered slide metadata found. Falling back to slide filename order.');
    return getFallbackSlidePaths(zip);
  }

  return orderedPaths;
}

async function getNotesSlidePath(zip: JSZip, slidePath: string): Promise<string | null> {
  const slideRelsPath = buildRelationshipPath(slidePath);
  const relationshipsXml = await readZipText(zip, slideRelsPath);
  if (!relationshipsXml) {
    return null;
  }

  const relationships = xmlParser.parse(relationshipsXml) as {
    Relationships?: { Relationship?: RelationshipEntry[] | RelationshipEntry };
  };

  for (const rel of arrayify(relationships.Relationships?.Relationship)) {
    if (rel.Target && rel.Type === NOTES_REL_TYPE) {
      return normalizeZipPath(getDirectoryPath(slidePath), rel.Target);
    }
  }

  return null;
}

function getFallbackSlidePaths(zip: JSZip): string[] {
  return Object.keys(zip.files)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => extractSlideNumber(left) - extractSlideNumber(right));
}

function extractSlideNumber(path: string): number {
  const match = path.match(/slide(\d+)\.xml$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) {
    return null;
  }

  return entry.async('string');
}

function buildRelationshipPath(partPath: string): string {
  const directory = getDirectoryPath(partPath);
  const fileName = partPath.slice(directory.length + 1);
  return `${directory}/_rels/${fileName}.rels`;
}

function getDirectoryPath(path: string): string {
  const lastSlashIndex = path.lastIndexOf('/');
  return lastSlashIndex === -1 ? '' : path.slice(0, lastSlashIndex);
}

function normalizeZipPath(basePath: string, targetPath: string): string {
  const segments = `${basePath}/${targetPath}`.split('/');
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      normalizedSegments.pop();
      continue;
    }

    normalizedSegments.push(segment);
  }

  return normalizedSegments.join('/');
}

function extractParagraphs(xml: string): string[] {
  const paragraphs = Array.from(xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g));
  const extracted = paragraphs
    .map(match => extractParagraphText(match[0]))
    .filter((text): text is string => Boolean(text));

  if (extracted.length > 0) {
    return extracted;
  }

  const fallbackText = extractParagraphText(xml);
  return fallbackText ? [fallbackText] : [];
}

function extractSlideRelationshipIds(xml: string): string[] {
  return Array.from(xml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)).map(match => match[1]);
}

function extractParagraphText(xmlFragment: string): string {
  const withLineBreaks = xmlFragment.replace(/<a:br\s*\/>/g, '\n').replace(/<a:tab\s*\/>/g, '\t');
  const textRuns = Array.from(withLineBreaks.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g))
    .map((match) => decodeXmlEntities(match[1]));

  return textRuns.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

function arrayify<T>(value: T | T[] | undefined): T[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}
