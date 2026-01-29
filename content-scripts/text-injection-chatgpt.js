// Text injection handler for ChatGPT
import { setupTextInjectionListener } from './text-injection-handler.js';

// ChatGPT uses #prompt-textarea
// Send button selectors (try multiple for different ChatGPT versions)
const sendButtonSelectors = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'form button[type="submit"]',
  'button.bg-black:has(svg)'
];

setupTextInjectionListener('#prompt-textarea', 'ChatGPT', sendButtonSelectors);
