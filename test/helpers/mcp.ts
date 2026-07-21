/** Parse one complete MCP Streamable-HTTP response in either JSON or SSE mode. */
export async function readMcpJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return (await response.json()) as T

  const body = await response.text()
  const messages = body.split(/\r?\n\r?\n/).flatMap((event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return []
    return [JSON.parse(data) as T]
  })
  if (messages.length !== 1) throw new Error(`expected one complete MCP message, received ${messages.length}`)
  return messages[0]!
}
