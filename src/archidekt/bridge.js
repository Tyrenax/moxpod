// Archidekt Redux store discovery via React fiber traversal.
//
// Archidekt's playtester-v2 uses Next.js + React + Redux. The Redux store
// is accessible by walking the React fiber tree from a known DOM element
// until we find a Redux Provider with a store whose state has a
// playtesterV2 slice.

/**
 * Find the Archidekt Redux store by walking the React fiber tree.
 * Returns { store, fiberKey } or null if not found.
 */
export function findArchidektStore() {
  // Try stable DOM entry points.
  const roots = [
    document.getElementById('play-area-v2'),
    document.getElementById('__next'),
  ].filter(Boolean);

  for (const root of roots) {
    const fiberKey = findFiberKey(root);
    if (!fiberKey) continue;

    let fiber = root[fiberKey];
    for (let depth = 0; depth < 500 && fiber; depth++) {
      const store = extractStoreFromFiber(fiber);
      if (store) return { store, fiberKey };
      fiber = fiber.return;
    }
  }

  // Broad fallback: try the first div with a fiber.
  const divs = document.querySelectorAll('div');
  for (const el of divs) {
    const fiberKey = findFiberKey(el);
    if (!fiberKey) continue;
    let fiber = el[fiberKey];
    for (let depth = 0; depth < 100 && fiber; depth++) {
      const store = extractStoreFromFiber(fiber);
      if (store) return { store, fiberKey };
      fiber = fiber.return;
    }
    break; // only try the first div that has a fiber
  }

  return null;
}

/**
 * Extract a Redux store from a fiber node by checking memoizedProps
 * and memoizedState for a value that looks like a Redux Provider context.
 */
function extractStoreFromFiber(fiber) {
  // Redux Provider passes store via context value.
  const candidates = [
    fiber.memoizedProps?.value,
    fiber.memoizedProps?.store,
    fiber.memoizedState?.store,
  ];

  // Also check context type (react-redux uses React.createContext).
  if (fiber.memoizedState?.memoizedState) {
    const ms = fiber.memoizedState;
    let node = ms;
    for (let i = 0; i < 10 && node; i++) {
      if (node.queue?.lastRenderedState?.store) {
        candidates.push(node.queue.lastRenderedState.store);
      }
      node = node.next;
    }
  }

  for (const candidate of candidates) {
    if (isReduxStore(candidate)) return candidate;
    // react-redux wraps the store in { store, subscription }
    if (candidate?.store && isReduxStore(candidate.store)) return candidate.store;
  }

  return null;
}

/**
 * Validate that an object is a Redux store with a playtesterV2 slice.
 */
function isReduxStore(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (typeof obj.getState !== 'function') return false;
  if (typeof obj.dispatch !== 'function') return false;
  if (typeof obj.subscribe !== 'function') return false;
  try {
    const state = obj.getState();
    return state && typeof state === 'object' && 'playtesterV2' in state;
  } catch {
    return false;
  }
}

/**
 * Discover the React fiber key on a DOM element.
 */
function findFiberKey(element) {
  return Object.keys(element).find(k =>
    k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
  ) || null;
}

/**
 * Discover the Redux action type for the merge-state action by
 * intercepting store.dispatch. Returns a promise that resolves with
 * the action type string, or rejects after a timeout.
 *
 * The Archidekt playtester uses a single "merge state" action type
 * for almost all game mutations. We capture it by watching for the
 * first dispatch whose payload contains game-relevant keys.
 */
export function discoverActionType(store, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const GAME_KEYS = new Set([
      'battlefield', 'hand', 'library', 'graveyard', 'exile',
      'commandZone', 'sideboard', 'lifeTotal', 'turnCounter',
      'cardCoordinates', 'selected',
    ]);

    const origDispatch = store.dispatch;
    const timer = setTimeout(() => {
      store.dispatch = origDispatch;
      reject(new Error('Timed out waiting for Archidekt action type discovery'));
    }, timeoutMs);

    store.dispatch = function interceptedDispatch(action) {
      if (action && typeof action === 'object' && action.type && action.payload) {
        const keys = Object.keys(action.payload);
        if (keys.some(k => GAME_KEYS.has(k))) {
          store.dispatch = origDispatch;
          clearTimeout(timer);
          console.log('[MoxMox MAIN] Discovered Archidekt action type:', action.type);
          resolve(action.type);
        }
      }
      return origDispatch.call(store, action);
    };
  });
}
