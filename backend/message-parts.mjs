export function visibleMessagePartsFromAssistant(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts.flatMap(part => {
    if (part?.type === 'text') return [{ kind: 'gu', text: String(part.text || '') }];
    if (part?.type === 'thinking') return [{ kind: 'think', text: String(part.thinking || '') }];
    return [];
  }).filter(item => item.text);
}
