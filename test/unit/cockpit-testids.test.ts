import { describe, expect, test } from 'bun:test'
import { globSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { testId } from '../../apps/cockpit/src/lib/test-id'

const files = [
  'apps/cockpit/src/pages/**/*.tsx',
  'apps/cockpit/src/components/**/*.tsx',
  'apps/cockpit/src/app/**/*.tsx',
]
  .flatMap((pattern) => globSync(pattern))
  .filter((file) => !file.includes('/components/ui/'))

const interactive = new Set([
  'Button',
  'Input',
  'Textarea',
  'SelectTrigger',
  'SelectItem',
  'Link',
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'Switch',
  'Checkbox',
  'RadioGroupItem',
  'ToggleGroupItem',
  'CollapsibleTrigger',
  'DropdownMenuTrigger',
  'DropdownMenuItem',
  'DropdownMenuCheckboxItem',
  'DropdownMenuRadioItem',
  'DropdownMenuSubTrigger',
  'SidebarTrigger',
  'SidebarMenuButton',
])

function testIdAttributes(source: string): string[] {
  return [...source.matchAll(/data-testid\s*=\s*(?:"[^"]*"|'[^']*'|\{`[^`]*`\}|\{[^}]*\})/g)].map((match) => match[0])
}

describe('the Cockpit data-testid contract', () => {
  test('normalizes readable segments and rejects opaque identifiers', () => {
    expect(testId('pages', 'row', 2, 'open')).toBe('pages-row-2-open')
    expect(() => testId('row', '11111111-1111-4111-8111-111111111111')).toThrow('opaque identifiers')
  })

  test('never puts opaque database identifiers into selectors', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const selectors = [
        ...testIdAttributes(source),
        ...[...source.matchAll(/rowTestId\s*=\s*\{[^\n]+/g)].map((match) => match[0]),
      ]
      for (const attribute of selectors) {
        for (const match of attribute.matchAll(/\$\{([A-Za-z_$][\w$]*\.)?(id|subject|[a-z_]+_id)\}/g)) {
          const owner = match[1]?.slice(0, -1)
          if (owner && ['stat', 'preset', 'option', 'event', 'group', 'tab', 'column'].includes(owner)) continue
          offenders.push(`${file}: ${attribute}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('every rendered interactive element has an explicit selector', () => {
    const offenders: string[] = []
    for (const file of files) {
      const parsed = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      function walk(node: ts.Node): void {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(parsed)
          const hasTestId = node.attributes.properties.some(
            (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === 'data-testid',
          )
          const delegates = node.attributes.properties.some(
            (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === 'asChild',
          )
          if (interactive.has(tag) && !hasTestId && !delegates) {
            const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
            offenders.push(`${file}:${line} <${tag}>`)
          }
        }
        ts.forEachChild(node, walk)
      }
      walk(parsed)
    }
    expect(offenders).toEqual([])
  })

  test('literal selectors use lower-case kebab names', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)) {
        const value = match[1]!
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) offenders.push(`${file}: ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('repeated decision cards prefix every trace selector with the readable card position', () => {
    const source = readFileSync('apps/cockpit/src/pages/decisions.tsx', 'utf8')
    expect(source).toContain('<DecisionTrace item={item} testId={`${testId}-trace`} />')
    expect(source).toContain('data-testid={`${testId}-origin-${index + 1}`}')
    expect(source).toContain('data-testid={`${testId}-target-${index + 1}`}')
    expect(source).not.toContain('data-testid="decision-trace"')
  })

  test('every icon-only page action has reachable tooltip copy', () => {
    const offenders: string[] = []
    for (const file of files) {
      const parsed = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      )
      function walk(node: ts.Node, insideTooltip: boolean): void {
        const isTooltip =
          ts.isJsxElement(node) && ['Tooltip', 'DisabledReason'].includes(node.openingElement.tagName.getText(parsed))
        const nested = insideTooltip || isTooltip
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(parsed)
          const size = node.attributes.properties.find(
            (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === 'size',
          )
          const value =
            size && ts.isJsxAttribute(size) && size.initializer && ts.isStringLiteral(size.initializer)
              ? size.initializer.text
              : null
          if (tag === 'Button' && value?.startsWith('icon') && !nested) {
            const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
            offenders.push(`${file}:${line}`)
          }
        }
        ts.forEachChild(node, (child) => walk(child, nested))
      }
      walk(parsed, false)
    }
    expect(offenders).toEqual([])
  })
})
