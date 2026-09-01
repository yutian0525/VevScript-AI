// agent/provider/types.ts
// 统一的消息/流式事件/Provider 抽象（设计 §4.2）。
// MVP 只有 OpenAICompatProvider 一个实现；Anthropic 适配器未来加入。

/** 统一内容块：文本或图片（截图以 base64 data URL 传入） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: string };

/** 统一消息格式（内部标准，provider 负责与 wire format 互转） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  /** assistant 消息携带的完整工具调用（wire 转换时使用） */
  toolCalls?: ToolCall[];
  /** tool 消息：对应的调用 id */
  toolCallId?: string;
  name?: string; // tool 消息的工具名
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串（模型输出原样）
}

/** 工具 schema：OpenAI function calling 格式（兼容协议的事实标准） */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
}

/** 流式事件（provider 把 wire 增量归一化为这几种） */
export type StreamEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'message-done'; usage?: Usage; finishReason?: string }
  | { type: 'error'; error: string };

export interface ChatParams {
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface Provider {
  /** 流式对话。返回 { cancel } 以中止。 */
  streamChat(
    params: ChatParams,
    onEvent: (event: StreamEvent) => void,
  ): { cancel: () => void };
}

/** Provider 构造配置 */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}
