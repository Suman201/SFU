import type { WhiteboardMemorySnapshot, WhiteboardCommand } from '@native-sfu/contracts';

/** Applies one acknowledged command without discarding unrelated pages or elements. */
export function applyWhiteboardMemoryCommand(snapshot: WhiteboardMemorySnapshot, command: WhiteboardCommand): WhiteboardMemorySnapshot {
  const next = structuredClone(snapshot);
  if (command.type === 'page-upsert') {
    const existing = next.pages.find((page) => page.id === command.page.id);
    next.pages = next.pages.filter((page) => page.id !== command.page.id);
    next.pages.splice(Math.min(command.page.order, next.pages.length), 0, { ...structuredClone(command.page), elements: existing?.elements ?? [] });
    next.pages.forEach((page, order) => { page.order = order; });
    next.activePageId ??= command.page.id;
    return next;
  }
  if (command.type === 'page-delete') {
    next.pages = next.pages.filter((page) => page.id !== command.pageId);
    if (next.activePageId === command.pageId) next.activePageId = next.pages[0]?.id;
    return next;
  }
  if (command.type === 'page-select') {
    if (next.pages.some((page) => page.id === command.pageId)) next.activePageId = command.pageId;
    return next;
  }
  const id = command.pageId ?? next.activePageId ?? next.pages[0]?.id ?? 'page-1';
  let page = next.pages.find((item) => item.id === id);
  if (!page) {
    page = { id, title: 'Shared page', tags: [], order: next.pages.length, elements: [] };
    next.pages.push(page);
    next.activePageId ??= id;
  }
  if (command.type === 'clear') page.elements = [];
  else if (command.type === 'delete') page.elements = page.elements.filter((element) => element.id !== command.elementId);
  else {
    const index = page.elements.findIndex((element) => element.id === command.element.id);
    const element = structuredClone(command.element) as unknown as Record<string, unknown>;
    if (command.elementIndex !== undefined) {
      if (index >= 0) page.elements.splice(index, 1);
      page.elements.splice(Math.min(command.elementIndex, page.elements.length), 0, element);
    } else if (index < 0) page.elements.push(element); else page.elements[index] = element;
  }
  return next;
}
