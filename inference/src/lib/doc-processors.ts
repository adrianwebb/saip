/**
 * Document processor plugins (data type registry). Each converts a raw upload
 * into an intermediate text format that training strategy plugins consume.
 * Processors transform; they never chunk or index. New formats register here.
 */

export interface ProcessMeta {
  sourceType: 'document' | 'repository' | 'dataset'
  ext?: string
}

export interface ProcessedDoc {
  intermediate: string
  processedBy: string
}

export interface DocProcessor {
  name: string
  accepts(meta: ProcessMeta): boolean
  process(content: string, meta: ProcessMeta): ProcessedDoc
}

const stripFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n?/, '')

export const markdownProcessor: DocProcessor = {
  name: 'markdown-processor',
  accepts: (m) => m.ext === '.md' || m.ext === '.mdx',
  process(content) {
    return { intermediate: stripFrontmatter(content), processedBy: this.name }
  },
}

const LANG_BY_EXT: Record<string, string> = {
  '.py': 'python', '.ts': 'typescript', '.js': 'javascript', '.rs': 'rust', '.go': 'go', '.java': 'java', '.rb': 'ruby',
}

export const codeProcessor: DocProcessor = {
  name: 'code-processor',
  accepts: (m) => !!m.ext && m.ext in LANG_BY_EXT,
  process(content, m) {
    const lang = LANG_BY_EXT[m.ext ?? ''] ?? 'text'
    return { intermediate: `// language: ${lang}\n${content}`, processedBy: this.name }
  },
}

export const jsonlProcessor: DocProcessor = {
  name: 'jsonl-processor',
  accepts: (m) => m.ext === '.jsonl' || m.sourceType === 'dataset',
  process(content) {
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean)
    let count = 0
    for (const line of lines) {
      try { JSON.parse(line); count++ } catch { throw new Error(`invalid JSONL line: ${line.slice(0, 40)}`) }
    }
    return { intermediate: `${count} records\n` + lines.join('\n'), processedBy: this.name }
  },
}

/** PDF requires Marker OCR backend; without one it is unsupported (typed error). */
export const pdfProcessor: DocProcessor = {
  name: 'pdf-processor',
  accepts: (m) => m.ext === '.pdf',
  process() {
    throw new Error('pdf-processor requires a Marker OCR backend; not configured')
  },
}

export const BUILTIN_PROCESSORS: DocProcessor[] = [markdownProcessor, codeProcessor, jsonlProcessor, pdfProcessor]

export function processorFor(meta: ProcessMeta, registered: DocProcessor[] = BUILTIN_PROCESSORS): DocProcessor | undefined {
  return registered.find((p) => p.accepts(meta))
}
