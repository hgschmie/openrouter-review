import { Minimatch } from 'minimatch';

export class DiffTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Raw diff exceeds max-diff-bytes (${maxBytes} bytes).`);
  }
}

// Consume the HTTP body incrementally, before the client can buffer the whole
// response. Buffer growth is bounded even if the server sends tiny chunks.
export async function readDiff(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  contentLength?: string | number,
): Promise<string> {
  const reader = body.getReader();
  let buffer = Buffer.alloc(0);
  let size = 0;
  try {
    if (
      contentLength !== undefined &&
      /^\d+$/.test(String(contentLength)) &&
      Number(contentLength) > maxBytes
    ) {
      throw new DiffTooLargeError(maxBytes);
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return buffer.toString('utf8', 0, size);
      const nextSize = size + value.byteLength;
      if (nextSize > maxBytes) throw new DiffTooLargeError(maxBytes);
      if (nextSize > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(nextSize, buffer.length * 2, 65536)));
        buffer.copy(grown, 0, 0, size);
        buffer = grown;
      }
      buffer.set(value, size);
      size = nextSize;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// Count Unicode code points without constructing a per-character array. Stop
// at the first excess character; zero disables only this post-filter limit.
export function exceedsCharLimit(text: string, limit: number): boolean {
  if (limit === 0 || text.length <= limit) return false;
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (++count > limit) return true;
    if (text.codePointAt(index)! > 0xffff) index++;
  }
  return false;
}

// Git's quoted paths use C escapes, including octal-encoded UTF-8 bytes.
function unquote(path: string): string {
  if (!path.startsWith('"')) return path;
  if (!path.endsWith('"')) throw new Error('Unterminated quoted path in GitHub diff.');
  const bytes: number[] = [];
  const escapes: Record<string, string> = {
    a: '\x07',
    b: '\b',
    t: '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    '\\': '\\',
    '"': '"',
  };
  for (const match of path.slice(1, -1).matchAll(/\\([0-7]{1,3}|.)|([^\\]+)/gs)) {
    if (match[1] && /^[0-7]+$/.test(match[1])) bytes.push(parseInt(match[1], 8));
    else bytes.push(...Buffer.from(match[1] ? (escapes[match[1]] ?? match[1]) : match[2]!));
  }
  return Buffer.from(bytes).toString('utf8');
}

function paths(block: string): string[] {
  const fileHeaders = [];
  for (const match of block.matchAll(/^(?:---|\+\+\+) (.+)$/gm)) {
    fileHeaders.push(match);
    if (fileHeaders.length === 2) break;
  }
  if (fileHeaders.length === 2) {
    return fileHeaders
      .map((match) => unquote(match[1]!))
      .filter((path) => path !== '/dev/null')
      .map((path) => path.slice(2));
  }
  const renames = [...block.matchAll(/^(?:rename|copy) (?:from|to) (.+)$/gm)];
  if (renames.length === 2) return renames.map((match) => unquote(match[1]!));
  const header = block.split('\n', 1)[0]!;
  const match = /^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(header);
  if (!match) throw new Error('Cannot determine file paths in GitHub diff.');
  const oldPath = unquote(match[1]!).slice(2);
  const newPath = unquote(match[2]!).slice(2);
  // Without rename metadata, identical old/new paths also disambiguate spaces
  // containing " b/" in a filename (mode-only changes have no ---/+++ headers).
  if (oldPath !== newPath && !header.includes('"')) {
    const rest = header.slice('diff --git a/'.length);
    for (const boundary of rest.matchAll(/ b\//g)) {
      const left = rest.slice(0, boundary.index);
      if (left === rest.slice(boundary.index + 3)) return [left];
    }
  }
  return [oldPath, newPath];
}

export function filterDiff(diff: string, include: string[], exclude: string[]): string {
  const matcher = (pattern: string) =>
    new Minimatch(pattern, { dot: true, matchBase: true, nonegate: true, nocomment: true });
  const includes = include.map(matcher);
  const excludes = exclude.map(matcher);
  if (!diff.trim()) return '';
  const blocks = diff.split(/(?=^diff --git )/m).filter((block) => block.trim());
  return blocks
    .filter((block) => {
      if (!block.startsWith('diff --git ')) throw new Error('GitHub returned an unrecognized diff format.');
      if (/^(?:Binary files .* differ|GIT binary patch)\r?$/m.test(block)) return false;
      const names = paths(block);
      return (
        (!includes.length || includes.some((glob) => names.some((name) => glob.match(name)))) &&
        !excludes.some((glob) => names.some((name) => glob.match(name)))
      );
    })
    .join('');
}
