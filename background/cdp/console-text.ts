// CDP RemoteObject[] → 可读文本（设计 §5.3）。纯函数、零往返：
// 不做 Runtime.getProperties（objectId 会过期，高频 console 下代价不可接受），对象只到 description / preview 浅层。
export const MAX_CONSOLE_TEXT = 4096;
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
