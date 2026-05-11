// React fiber traversal utilities for finding Moxfield's playtest component.
//
// IMPORTANT: This code must run in the page's main world (not the extension's
// isolated content-script world) to access React internals on DOM elements.
// Chrome and Firefox MV3 both support "world": "MAIN" on content_scripts.

const REQUIRED_ZONES = ['hand', 'library', 'battlefield', 'graveyard', 'exile'];
const REQUIRED_METHODS = ['handleSaveData', 'handleDraw', 'handleShuffle'];

/**
 * Find the Moxfield playtest class component instance by walking the React
 * fiber tree from DOM elements. Returns null if not on a playtest page.
 */
export function findPlaytestInstance() {
  // Start from elements likely to be INSIDE the playtest component tree
  // (children of the playtest component). Walking up via fiber.return will
  // then reach the playtest class component.
  //
  // We cannot start from <main> because the playtest component is a
  // descendant of <main>, not an ancestor — walking up from <main> goes
  // toward the React root and misses it.
  const selectors = [
    'img[alt="Card Image"]',      // library top card
    'img[alt="Open Menu"]',       // card context menu button
    '[class*="hand"] img',        // card in hand
    'nav li',                     // toolbar items
  ];

  for (const sel of selectors) {
    const elements = document.querySelectorAll(sel);
    for (const el of elements) {
      const fiberKey = findFiberKey(el);
      if (!fiberKey) continue;

      let current = el[fiberKey];
      for (let depth = 0; depth < 50 && current; depth++) {
        if (isPlaytestInstance(current.stateNode)) {
          return current.stateNode;
        }
        current = current.return;
      }
    }
  }

  // Broad fallback: try every div.
  const divs = document.querySelectorAll('div');
  for (const el of divs) {
    const fiberKey = findFiberKey(el);
    if (!fiberKey) continue;

    let current = el[fiberKey];
    for (let depth = 0; depth < 50 && current; depth++) {
      if (isPlaytestInstance(current.stateNode)) {
        return current.stateNode;
      }
      current = current.return;
    }
  }

  return null;
}

/**
 * Discover the React fiber key on a DOM element.
 * The suffix (e.g. $422baita3w5) changes on each page load.
 */
function findFiberKey(element) {
  return Object.keys(element).find(k => k.startsWith('__reactFiber')) || null;
}

/**
 * Validates that a React stateNode is the Moxfield playtest component by
 * checking for required zones arrays and handler methods.
 */
function isPlaytestInstance(stateNode) {
  if (!stateNode || stateNode === window) return false;
  if (typeof stateNode.setState !== 'function') return false;

  const state = stateNode.state;
  if (!state || !state.zones) return false;

  for (const zone of REQUIRED_ZONES) {
    if (!Array.isArray(state.zones[zone])) return false;
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof stateNode[method] !== 'function') return false;
  }

  return true;
}
