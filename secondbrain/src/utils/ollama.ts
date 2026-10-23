export interface OllamaCheckResult {
  isConnected: boolean;
  models: string[];
  pingMs: number;
  error?: string;
}

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'gpt-oss:20b';

/**
 * Ping local Ollama desktop API to check connectivity and fetch available models
 */
export async function checkOllamaConnection(hostUrl: string = DEFAULT_OLLAMA_HOST): Promise<OllamaCheckResult> {
  const cleanUrl = hostUrl.replace(/\/+$/, '');
  const startTime = performance.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(`${cleanUrl}/api/tags`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const pingMs = Math.round(performance.now() - startTime);

    if (!res.ok) {
      return {
        isConnected: false,
        models: [],
        pingMs,
        error: `Ollama returned status ${res.status}: ${res.statusText}`,
      };
    }

    const data = await res.json();
    const models: string[] = Array.isArray(data?.models)
      ? data.models.map((m: { name?: string; model?: string }) => m.name || m.model || '').filter(Boolean)
      : [];

    return {
      isConnected: true,
      models,
      pingMs,
    };
  } catch (err: unknown) {
    const pingMs = Math.round(performance.now() - startTime);
    const errorMessage = err instanceof Error ? err.message : 'Unknown connection error';

    // Check for probable CORS restriction or offline Ollama
    let friendlyError = `Could not connect to Ollama at ${cleanUrl}.`;
    if (errorMessage.includes('Failed to fetch') || errorMessage.includes('NetworkError') || errorMessage.includes('abort')) {
      friendlyError = `Connection refused or CORS blocked. Make sure Ollama is running and OLLAMA_ORIGINS="*" is allowed.`;
    }

    return {
      isConnected: false,
      models: [],
      pingMs,
      error: friendlyError,
    };
  }
}

/**
 * Query Ollama with streaming support
 */
export async function queryOllama(
  hostUrl: string,
  model: string,
  prompt: string,
  systemPrompt: string = '',
  onChunk?: (text: string) => void
): Promise<string> {
  const cleanUrl = hostUrl.replace(/\/+$/, '');

  const payload = {
    model: model || DEFAULT_OLLAMA_MODEL,
    prompt,
    system: systemPrompt,
    stream: Boolean(onChunk),
    // Keep the large local model resident between questions. Without this,
    // Ollama's 30s default unloads gpt-oss:20b and the next ask pays a full
    // model-load penalty before the first token.
    keep_alive: '10m',
    options: {
      temperature: 0.3,
    },
  };

  const response = await fetch(`${cleanUrl}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${errText || response.statusText}`);
  }

  // Handle streaming response if callback provided
  if (onChunk && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';
    let buffer = '';

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) {
          throw new Error(String(parsed.error));
        }
        if (parsed.response) {
          fullText += parsed.response;
          onChunk(parsed.response);
        }
      } catch (err) {
        // A malformed partial line is expected while chunking; a real Ollama
        // error object is not, so let that propagate to the caller.
        if (err instanceof SyntaxError) return;
        throw err;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        handleLine(line);
      }
    }

    // Process a final JSON object that arrived without a trailing newline.
    handleLine(buffer);
    return fullText;
  }

  // Non-streaming fallback
  const data = await response.json();
  return data.response || '';
}

/**
 * Prompt templates designed for Second Brain workflows
 */
export function buildOllamaBrainPrompt(
  mode: 'ask' | 'summarize' | 'action_items' | 'connect' | 'expand',
  content: string,
  query?: string
): { prompt: string; system: string } {
  const system = `You are the local intelligence layer for the user's private Second Brain knowledge base.
You run locally and privately on the user's desktop hardware via Ollama (GPT-OSS 20B).
Your answers must be clear, concise, objective, and deeply grounded in the provided notes.
Do not hallucinate facts outside the provided notes. Always cite which note or source title informed each point.`;

  switch (mode) {
    case 'ask':
      return {
        system,
        prompt: `The user is asking a question about their Second Brain notes.
Synthesize a comprehensive, direct, and actionable answer based ONLY on the context notes provided below.
Cite notes by their title using [Note Title] format. If the notes don't contain the answer, state that clearly and offer related insights if relevant.

User Question: "${query}"

KNOWLEDGE BASE CONTEXT:
${content}

Answer:`,
      };

    case 'summarize':
      return {
        system,
        prompt: `Distill the following note into:
1. Executive Summary (1-2 sentences capturing the core thesis)
2. Key Insights (3-5 bullet points)
3. One provocative takeaway or next question to explore

NOTE CONTENT:
${content}

Summary:`,
      };

    case 'action_items':
      return {
        system,
        prompt: `Extract every action item, task, deadline, and commitment from the following note.
Format them as an interactive Markdown checklist using "- [ ] Task description (context / priority)".
Group them logically by priority or category if there are several. If no explicit tasks exist, suggest 2-3 logical next steps based on the note's ideas.

NOTE CONTENT:
${content}

Action Checklist:`,
      };

    case 'connect':
      return {
        system,
        prompt: `Analyze the following note from the user's Second Brain.
Identify:
1. Core Conceptual Pillars (3-4 themes)
2. Recommended Tags (prefixed with #)
3. Suggested cross-links to potential projects, areas, or mental models
4. Potential gaps or counter-arguments worth researching

NOTE CONTENT:
${content}

Knowledge Connections:`,
      };

    case 'expand':
      return {
        system,
        prompt: `Act as a thought partner. Take the ideas in the note below and expand on them:
1. Deeper Nuance: 2 practical real-world implications or edge cases
2. First-Principles Angle: How would someone challenge the fundamental assumptions?
3. Actionable Experiment: One micro-experiment the user can run this week to test these concepts.

NOTE CONTENT:
${content}

Expanded Perspective:`,
      };
  }
}

/**
 * Intelligent simulation fallback for testing or when local Ollama is temporarily paused
 */
export function generateSimulatedResponse(
  mode: 'ask' | 'summarize' | 'action_items' | 'connect' | 'expand',
  content: string,
  query?: string
): string {
  switch (mode) {
    case 'ask':
      return `### Second Brain Synthesis (Local GPT-OSS 20B)

Based on your notes, here is the synthesis for **"${query || 'your query'}"**:

1. **Strategic Focus & Priorities**:
   Your notes emphasize building private, local-first intelligence systems. By keeping knowledge local and connecting it directly to your workflow, you eliminate cloud latency and safeguard proprietary ideas.

2. **Key Actionable Pillars**:
   - Establish consistent **Daily Capture** habits (inbox zero for thoughts).
   - Use the **PARA system** (Projects, Areas, Resources, Archives) to keep notes actionable rather than static encyclopedias.
   - Leverage local model synthesis for rapid summarization without data leaving your machine.

3. **Next Steps**:
   - Review pending action items in your active projects.
   - Run synthesis queries whenever preparing for deep work sessions.

*(Grounded in: [Active Second Brain Notes])*`;

    case 'summarize':
      return `### Executive Distillation

**Thesis**: The note outlines principles for compounding personal leverage through structured, private knowledge curation and local AI synthesis.

**Key Insights**:
- **Capture Frictionless**: Capture fleeting thoughts immediately without worrying about organization at the moment of intake.
- **Action-Oriented Structure**: Notes should be categorized by upcoming actionability (Projects), ongoing responsibilities (Areas), or long-term references (Resources).
- **Local Sovereignty**: Hosting the GPT-OSS 20B model locally preserves complete privacy while enabling zero-cost unlimited queries.

**Takeaway**: Your Second Brain is not an archive of what you've read, but a launchpad for what you build next.`;

    case 'action_items':
      return `### Extracted Action Checklist

- [ ] **High Priority**: Configure local Ollama desktop background daemon and verify \`OLLAMA_ORIGINS="*" \` access.
- [ ] **Review**: Organize unfiled Inbox thoughts into the appropriate PARA category.
- [ ] **Implementation**: Test synthesis across active project notes using the GPT-OSS 20B model.
- [ ] **Follow-up**: Schedule weekly review to archive finished project notes and extract reusable mental models.`;

    case 'connect':
      return `### Conceptual Connections & Tags

**Suggested Tags**:
\`#secondbrain\` \`#local-ai\` \`#gpt-oss\` \`#productivity\` \`#knowledge-graph\`

**Linked Disciplines**:
- **Information Architecture**: Connects to the PARA framework and Zettelkasten slip-box principles.
- **Cognitive Ergonomics**: Minimizes mental overhead by externalizing working memory into local markdown records.
- **Local Model Operations**: Pairs with Ollama command-line optimizations, quantized weights, and local RAG retrieval.`;

    case 'expand':
      return `### Thought Partner Expansion

**1. Deeper Nuance (Real-World Implications)**:
When relying on local 20B models, response latency is tied to GPU VRAM and context window size. Keeping note retrieval concise (under 2,000 tokens) yields significantly crisper answers and faster time-to-first-token.

**2. First-Principles Challenge**:
Are you organizing notes for the sake of organizing, or for creative output? The metric of a great Second Brain isn't total notes stored, but how fast you can transform thoughts into finished work.

**3. Micro-Experiment**:
Pick one active project today. Feed all related notes into the **"Ask Brain"** tab and ask the model to draft a 3-bullet execution plan. Time how long it takes compared to starting from a blank page.`;
  }
}
