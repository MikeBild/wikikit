import { describe, expect, test } from 'bun:test'
import { globSync, readFileSync } from 'node:fs'
import ts from 'typescript'

const cockpitFiles = globSync('apps/cockpit/src/{app,components,pages}/**/*.tsx')
const pageFiles = globSync('apps/cockpit/src/pages/**/*.tsx')

function source(file: string): string {
  return readFileSync(file, 'utf8')
}

describe('the Cockpit action hierarchy', () => {
  test('one semantic default variant owns every primary action', () => {
    const button = source('apps/cockpit/src/components/ui/button.tsx')
    expect(button).toContain("default: 'bg-accent text-accent-foreground hover:bg-accent/90'")
    expect(button).not.toMatch(/^\s+accent:/m)

    const offenders = pageFiles.filter((file) => /variant=["']accent["']/.test(source(file)))
    expect(offenders).toEqual([])
  })

  test('page-header actions are not repeated inside their empty states', () => {
    const retiredSelectors = [
      'pages-empty-new',
      'add-documents-empty',
      'register-endpoint-empty',
      'mint-key-empty',
      'grant-access-empty',
    ]
    const allPages = pageFiles.map(source).join('\n')
    for (const selector of retiredSelectors) expect(allPages).not.toContain(selector)
  })

  test('tables that exceeded the phone viewport collapse secondary columns', () => {
    const minimumResponsiveColumns: Record<string, number> = {
      'changes.tsx': 2,
      'sources.tsx': 6,
      'spaces.tsx': 3,
      'api-keys.tsx': 3,
      'identities.tsx': 4,
      'webhooks.tsx': 8,
      'charter.tsx': 2,
    }
    for (const [page, minimum] of Object.entries(minimumResponsiveColumns)) {
      const contents = source(`apps/cockpit/src/pages/${page}`)
      expect(contents.match(/priority: '(?:secondary|optional)'/g)?.length ?? 0, page).toBeGreaterThanOrEqual(minimum)
    }

    const table = source('apps/cockpit/src/components/ui/data-table.tsx')
    expect(table).toContain("column.priority === 'secondary'")
    expect(table).toContain("column.priority === 'optional'")
    expect(table).toContain("(column.priority ?? 'essential') === 'essential'")
    const primitive = source('apps/cockpit/src/components/ui/table.tsx')
    expect(primitive).toContain('w-full table-fixed')
    expect(primitive).not.toContain('overflow-x-auto')
    const browserCheck = source('scripts/check-cockpit-browser.ts')
    expect(browserCheck).toContain('exceeds its surface')
    expect(browserCheck).toContain('duplicate data-testid')
    expect(browserCheck).toContain('interactive element has no data-testid')
    expect(browserCheck).not.toContain("table.dataset.testid === 'pages-table'")
  })

  test('icons beside button copy use the shadcn data-icon contract', () => {
    const offenders: string[] = []
    for (const file of cockpitFiles.filter((path) => !path.includes('/components/ui/'))) {
      const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const lucide = new Set<string>()
      for (const statement of parsed.statements) {
        if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.getText(parsed) !== "'lucide-react'")
          continue
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) lucide.add(item.name.text)
        }
      }

      function walk(node: ts.Node): void {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(parsed) === 'Button') {
          const carriesCopy = node.children.some(
            (child) =>
              (ts.isJsxText(child) && child.text.trim().length > 0) ||
              (ts.isJsxExpression(child) && child.expression !== undefined && !ts.isJsxElement(child.expression)),
          )
          if (carriesCopy) {
            function inspectIcon(child: ts.Node): void {
              if (ts.isJsxSelfClosingElement(child) && lucide.has(child.tagName.getText(parsed))) {
                const hasDataIcon = child.attributes.properties.some(
                  (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === 'data-icon',
                )
                if (!hasDataIcon) {
                  const line = parsed.getLineAndCharacterOfPosition(child.getStart(parsed)).line + 1
                  offenders.push(`${file}:${line} <${child.tagName.getText(parsed)}>`)
                }
              }
              ts.forEachChild(child, inspectIcon)
            }
            for (const child of node.children) inspectIcon(child)
          }
        }
        ts.forEachChild(node, walk)
      }
      walk(parsed)
    }
    expect(offenders).toEqual([])
  })

  test('uses the shared shadcn structure for tabs, forms and page actions', () => {
    const tabs = source('apps/cockpit/src/components/ui/tabs.tsx')
    expect(tabs).toContain("import { Tabs as TabsPrimitive } from 'radix-ui'")
    expect(tabs).toContain('<TabsPrimitive.List')
    expect(tabs).toContain('<TabsPrimitive.Trigger')

    const editor = source('apps/cockpit/src/pages/page-edit.tsx')
    expect(editor).toContain('<FieldGroup>')
    expect(editor).toContain('<Field>')
    for (const page of ['api-keys.tsx', 'identities.tsx', 'webhooks.tsx']) {
      expect(source(`apps/cockpit/src/pages/${page}`)).toContain('<FieldGroup className="overflow-y-auto">')
    }

    const shell = source('apps/cockpit/src/app/shell.tsx')
    expect(shell).toContain('data-testid="page-actions"')
    expect(shell).toContain('flex-wrap')
  })
})

describe('the Cockpit explanation hierarchy', () => {
  test('native title attributes cannot stand in for reachable help', () => {
    const offenders: string[] = []
    for (const file of cockpitFiles) {
      const parsed = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      function walk(node: ts.Node): void {
        if (ts.isJsxOpeningLikeElement(node) && /^[a-z]/.test(node.tagName.getText(parsed))) {
          const hasTitle = node.attributes.properties.some(
            (property) => ts.isJsxAttribute(property) && property.name.getText(parsed) === 'title',
          )
          if (hasTitle) {
            const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1
            offenders.push(`${file}:${line} <${node.tagName.getText(parsed)}>`)
          }
        }
        ts.forEachChild(node, walk)
      }
      walk(parsed)
    }
    expect(offenders).toEqual([])
  })

  test('context help combines focusable tooltip copy with click and touch content', () => {
    const help = source('apps/cockpit/src/components/context-help.tsx')
    expect(help).toContain('<TooltipTrigger asChild>')
    expect(help).toContain('<PopoverTrigger asChild>')
    expect(help).toContain('const label = text(title)')
    expect(help).toContain('aria-label={label}')
    expect(help).toContain('data-testid={`${testId}-trigger`}')
    expect(help).toContain('data-testid={`${testId}-content`}')
  })

  test('custom table empty states replace, rather than stack with, the generic icon', () => {
    const table = source('apps/cockpit/src/components/ui/data-table.tsx')
    expect(table).toContain("const custom = message !== undefined && typeof message !== 'string'")
    expect(table).toContain('<I18nText>{message}</I18nText>')
  })
})
