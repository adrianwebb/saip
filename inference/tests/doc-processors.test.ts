import { describe, it, expect } from 'vitest'
import { markdownProcessor, codeProcessor, jsonlProcessor, pdfProcessor, processorFor } from '../src/lib/doc-processors.js'

describe('document processors', () => {
  it('markdown strips frontmatter and keeps heading hierarchy', () => {
    const out = markdownProcessor.process('---\ntitle: X\n---\n# H1\ntext\n## H2', { sourceType: 'document' })
    expect(out.intermediate).not.toContain('title: X')
    expect(out.intermediate).toContain('# H1')
    expect(out.intermediate).toContain('## H2')
    expect(out.processedBy).toBe('markdown-processor')
  })

  it('code tags language from extension metadata', () => {
    const out = codeProcessor.process('def f(): pass', { sourceType: 'document', ext: '.py' })
    expect(out.intermediate).toContain('python')
    expect(out.intermediate).toContain('def f(): pass')
  })

  it('jsonl validates lines and rejects malformed', () => {
    const good = jsonlProcessor.process('{"text":"a"}\n{"text":"b"}', { sourceType: 'dataset' })
    expect(good.intermediate).toContain('2 records')
    expect(() => jsonlProcessor.process('{"oops"', { sourceType: 'dataset' })).toThrow(/invalid JSONL/)
  })

  it('pdf requires a Marker backend (typed error otherwise)', () => {
    expect(() => pdfProcessor.process('%PDF-1.4 ...', { sourceType: 'document' })).toThrow(/Marker|backend/i)
  })

  it('processorFor selects by extension / source type', () => {
    expect(processorFor({ ext: '.md' })?.name).toBe('markdown-processor')
    expect(processorFor({ ext: '.py' })?.name).toBe('code-processor')
    expect(processorFor({ ext: '.jsonl' })?.name).toBe('jsonl-processor')
    expect(processorFor({ ext: '.pdf' })?.name).toBe('pdf-processor')
    expect(processorFor({ ext: '.zip' })).toBeUndefined()
  })
})
