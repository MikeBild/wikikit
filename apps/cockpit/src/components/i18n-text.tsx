import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { useI18n } from '@/lib/i18n-context'

const TRANSLATED_PROPS = [
  'aria-label',
  'confirmLabel',
  'description',
  'empty',
  'hint',
  'label',
  'placeholder',
  'title',
] as const

function translateNode(node: ReactNode, text: (source: string) => string): ReactNode {
  if (typeof node === 'string') return text(node)
  if (Array.isArray(node)) return node.map((child) => translateNode(child, text))
  if (!isValidElement(node)) return node
  const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>
  const props: Record<string, unknown> = {}
  for (const name of TRANSLATED_PROPS) {
    const value = element.props[name]
    if (typeof value === 'string') props[name] = text(value)
  }
  if (element.props.children !== undefined) props.children = translateNode(element.props.children, text)
  return Object.keys(props).length > 0 ? cloneElement(element, props) : element
}

/** Translate reviewed static phrases and presentation props without touching data values. */
export function I18nText({ children }: { children: ReactNode }) {
  const { text } = useI18n()
  return <>{translateNode(children, text)}</>
}
