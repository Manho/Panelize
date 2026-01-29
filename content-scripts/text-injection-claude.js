// Text injection handler for Claude
import { setupTextInjectionListener } from './text-injection-handler.js';

// Claude uses .ProseMirror contenteditable with role="textbox"
// Send button selectors
const sendButtonSelectors = [
  'button[aria-label="Send Message"]',
  'button[aria-label="Send message"]',
  'fieldset button:has(svg)',
  'button.bg-accent-main-100'
];

setupTextInjectionListener('.ProseMirror[role="textbox"]', 'Claude', sendButtonSelectors);
