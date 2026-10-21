import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Render untrusted Markdown (notes, imported notes, or local model output) to
 * HTML with the dangerous parts stripped.
 *
 * `marked` deliberately does not sanitize HTML. Both note bodies and model
 * answers can contain attacker-controlled markup (for example an imported note
 * or a prompt-injected answer), so every `dangerouslySetInnerHTML` sink in the
 * app must go through this function.
 */
export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown || '', {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;

  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}
