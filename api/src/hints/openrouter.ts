// OpenRouter chat completions client (DESIGN.md §8). fetch is injected: tests always mock it.

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const LEVEL_PARAMS: Record<1 | 2 | 3, { max_tokens: number; temperature: number; timeout_ms: number }> = {
  1: { max_tokens: 220, temperature: 0.3, timeout_ms: 20_000 },
  2: { max_tokens: 320, temperature: 0.3, timeout_ms: 20_000 },
  3: { max_tokens: 550, temperature: 0.4, timeout_ms: 30_000 },
};
export const REGENERATE_TEMPERATURE = 0.2;

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  fallbacks: string[];
  providerIgnore: string[];
  fetch: typeof fetch;
  /** Called for every guard failure (reasoning tokens, empty length-cut output). */
  onGuardFailure?: (what: string, detail: Record<string, unknown>) => void;
}

export interface CompletionRequest {
  system: string;
  user: string;
  level: 1 | 2 | 3;
  temperature?: number;
  /** sha256(user_id + SESSION_SECRET), never the raw id. */
  userHash: string;
}

export interface CompletionResult {
  text: string;
  model: string | null;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  ttft_ms: number | null;
  latency_ms: number;
  finish_reason: string | null;
  guard: string[];
}

export class OpenRouterError extends Error {
  /** Cost already spent by failed attempts, so the daily stop still sees it. */
  readonly cost_usd: number;
  constructor(message: string, cost = 0) {
    super(message);
    this.cost_usd = cost;
  }
}

export function requestBody(o: OpenRouterOptions, r: CompletionRequest): Record<string, unknown> {
  const p = LEVEL_PARAMS[r.level];
  return {
    model: o.model,
    models: o.fallbacks,
    reasoning: { enabled: false },
    provider: { ignore: o.providerIgnore },
    max_tokens: p.max_tokens,
    temperature: r.temperature ?? p.temperature,
    stream: false,
    usage: { include: true },
    user: r.userHash,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.user },
    ],
  };
}

interface ORResponse {
  model?: string;
  provider?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; code?: number | string };
}

/** One call with one retry (the `models` array already gives OpenRouter-side fallback). */
export async function complete(o: OpenRouterOptions, r: CompletionRequest): Promise<CompletionResult> {
  let lastErr: unknown;
  let spent = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await once(o, r);
    } catch (err) {
      lastErr = err;
      if (err instanceof OpenRouterError) spent += err.cost_usd;
    }
  }
  throw new OpenRouterError((lastErr as Error)?.message ?? 'openrouter failed', spent);
}

async function once(o: OpenRouterOptions, r: CompletionRequest): Promise<CompletionResult> {
  const started = Date.now();
  const res = await o.fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${o.apiKey}`,
      'content-type': 'application/json',
      'x-title': 'C Exam Gym',
    },
    body: JSON.stringify(requestBody(o, r)),
    signal: AbortSignal.timeout(LEVEL_PARAMS[r.level].timeout_ms),
  });
  const ttft = Date.now() - started;
  const json = (await res.json().catch(() => ({}))) as ORResponse;
  const latency = Date.now() - started;
  if (!res.ok || json.error) {
    throw new OpenRouterError(`openrouter ${res.status}: ${json.error?.message ?? 'error'}`);
  }
  const choice = json.choices?.[0];
  const text = (choice?.message?.content ?? '').trim();
  const finish = choice?.finish_reason ?? null;
  const reasoning = json.usage?.completion_tokens_details?.reasoning_tokens ?? null;
  const cost = typeof json.usage?.cost === 'number' ? json.usage.cost : null;
  const guard: string[] = [];
  if (reasoning !== null && reasoning > 0) {
    guard.push('reasoning_tokens');
    o.onGuardFailure?.('reasoning_tokens', { reasoning_tokens: reasoning, model: json.model });
  }
  if (finish === 'length' && !text) {
    o.onGuardFailure?.('length_empty', { model: json.model });
    throw new OpenRouterError('finish_reason=length with empty content', cost ?? 0);
  }
  if (!text) throw new OpenRouterError('empty content', cost ?? 0);
  return {
    text,
    model: json.model ?? null,
    provider: json.provider ?? null,
    input_tokens: json.usage?.prompt_tokens ?? null,
    output_tokens: json.usage?.completion_tokens ?? null,
    reasoning_tokens: reasoning,
    cost_usd: cost,
    ttft_ms: ttft,
    latency_ms: latency,
    finish_reason: finish,
    guard,
  };
}
