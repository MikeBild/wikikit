import { describe, expect, test } from 'bun:test'
import { globSync, readFileSync } from 'node:fs'
import ts from 'typescript'

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

describe('the Cockpit data-testid contract', () => {
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
})
