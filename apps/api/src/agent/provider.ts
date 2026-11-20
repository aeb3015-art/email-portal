import Anthropic from '@anthropic-ai/sdk';

export interface CompletionRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  model?: string | null;
}

/** Bring-your-own-key provider interface. Add OpenAI etc. by implementing this. */
export interface AIProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<string>;
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }
  async complete(req: CompletionRequest): Promise<string> {
    const res = await this.client.messages.create({
      model: req.model || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: req.maxTokens ?? 2000,
      system: req.system,
      messages: req.messages,
    });
    return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
}

export type ProviderFactory = (provider: string, apiKey: string) => AIProvider;
let factory: ProviderFactory = (provider, apiKey) => {
  if (provider === 'anthropic') return new AnthropicProvider(apiKey);
  throw new Error(`Unsupported AI provider ${provider}`);
};
export const makeProvider: ProviderFactory = (p, k) => factory(p, k);
/** Tests inject a fake model here. */
export function setProviderFactory(f: ProviderFactory): void { factory = f; }
