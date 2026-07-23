// Typing for Bun compile-time text imports (`import x from './f.txt'
// with { type: 'text' }`). Bun inlines the file content as a string into
// `bun build --compile`; this declaration lets tsc type it as a string.
declare module '*.txt' {
  const content: string
  export default content
}

declare module '*.md' {
  const content: string
  export default content
}

declare module '*.sh' {
  const content: string
  export default content
}

declare module '*.ps1' {
  const content: string
  export default content
}
