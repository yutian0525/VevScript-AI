// CDP RemoteObject[] → 可读文本（设计 §5.3）。纯函数、零往返：
// 不做 Runtime.getProperties（objectId 会过期，高频 console 下代价不可接受），对象只到 description / preview 浅层。
export const MAX_CONSOLE_TEXT = 4096;
/** 堆栈帧上限：深层递归可达数百帧，10 帧足够定位调用点。 */
const MAX_STACK_FRAMES = 10;
/** 堆栈文本上限：10 帧 × 单帧约 200 字符的余量，与正文同一档截断纪律。 */
export const MAX_CONSOLE_STACK = 2048;
const PREVIEW_MAX_PROPS = 5;

/** CDP Runtime.RemoteObject 的最小可用形状（只取序列化用得到的字段，便于测试构造）。 */
export interface RemoteObjectLike {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: {
    properties?: Array<{ name: string; value?: string }>;
    overflow?: boolean;
  };
}

function serializeOne(arg: RemoteObjectLike): string {
  if (arg.subtype === 'null') return 'null';
  switch (arg.type) {
    case 'string': return String(arg.value ?? '');
    case 'number': case 'boolean': return String(arg.value);
    case 'undefined': return 'undefined';
    case 'bigint': case 'symbol': case 'function':
      return arg.description || (arg.type === 'function' ? 'ƒ' : arg.type);
    default: break;
  }
  if (arg.description) return arg.description;
  const props = arg.preview?.properties;
  if (props?.length) {
    const shown = props.slice(0, PREVIEW_MAX_PROPS).map((p) => `${p.name}: ${p.value ?? '…'}`);
    if (props.length > PREVIEW_MAX_PROPS || arg.preview?.overflow) shown.push('…');
    return `{${shown.join(', ')}}`;
  }
  return '[object]';
}

/** 多参以空格连接；总长截断到 MAX_CONSOLE_TEXT（截断时末尾加省略号）。 */
export function serializeRemoteObjects(args: RemoteObjectLike[]): string {
  const text = args.map(serializeOne).join(' ');
  if (text.length <= MAX_CONSOLE_TEXT) return text;
  return `${text.slice(0, MAX_CONSOLE_TEXT)}…`;
}

/** CDP Runtime.StackTrace 的最小可用形状。 */
export interface StackTraceLike {
  callFrames?: Array<{
    functionName?: string; url?: string; lineNumber?: number; columnNumber?: number;
  }>;
}

/**
 * CDP stackTrace → `函数名 @ url:行:列` 每帧一行（最多 MAX_STACK_FRAMES 帧，总长截到
 * MAX_CONSOLE_STACK）。无帧返回 undefined——调用方据此不写 stack 键，条目保持原形状。
 */
export function formatStackTrace(stackTrace?: StackTraceLike): string | undefined {
  const frames = stackTrace?.callFrames;
  if (!frames?.length) return undefined;
  const text = frames.slice(0, MAX_STACK_FRAMES)
    .map((f) => `${f.functionName || '(anonymous)'} @ ${f.url ?? ''}:${f.lineNumber ?? 0}:${f.columnNumber ?? 0}`)
    .join('\n');
  return text.length <= MAX_CONSOLE_STACK ? text : `${text.slice(0, MAX_CONSOLE_STACK)}…`;
}
